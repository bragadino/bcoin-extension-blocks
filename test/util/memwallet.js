/*!
 * memwallet.js - in-memory wallet object for bcoin
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var assert = require('assert');
var Network = require('../../lib/protocol/network');
var util = require('../../lib/utils/util');
var MTX = require('../../lib/primitives/mtx');
var HD = require('../../lib/hd/hd');
var Bloom = require('../../lib/utils/bloom');
var KeyRing = require('../../lib/primitives/keyring');
var Outpoint = require('../../lib/primitives/outpoint');
var Coin = require('../../lib/primitives/coin');
var co = require('../../lib/utils/co');

function MemWallet(options) {
  if (!(this instanceof MemWallet))
    return new MemWallet(options);

  this.network = Network.primary;
  this.master = null;
  this.key = null;
  this.witness = false;
  this.account = 0;
  this.receiveDepth = 1;
  this.changeDepth = 1;
  this.receive = null;
  this.change = null;
  this.map = {};
  this.coins = {};
  this.spent = {};
  this.paths = {};
  this.balance = 0;
  this.txs = 0;
  this.filter = Bloom.fromRate(1000000, 0.001, -1);

  if (options)
    this.fromOptions(options);

  this.init();
}

MemWallet.prototype.fromOptions = function fromOptions(options) {
  if (options.network != null) {
    assert(options.network);
    this.network = Network.get(options.network);
  }

  if (options.master != null) {
    assert(options.master);
    this.master = HD.PrivateKey.fromOptions(options.master, this.network);
  }

  if (options.key != null) {
    assert(HD.isPrivate(options.key));
    this.key = options.key;
  }

  if (options.witness != null) {
    assert(typeof options.witness === 'boolean');
    this.witness = options.witness;
  }

  if (options.account != null) {
    assert(typeof options.account === 'number');
    this.account = options.account;
  }

  if (options.receiveDepth != null) {
    assert(typeof options.receiveDepth === 'number');
    this.receiveDepth = options.receiveDepth;
  }

  if (options.changeDepth != null) {
    assert(typeof options.changeDepth === 'number');
    this.changeDepth = options.changeDepth;
  }

  return this;
};

MemWallet.prototype.init = function init() {
  var i;

  if (!this.master)
    this.master = HD.PrivateKey.generate();

  if (!this.key)
    this.key = this.master.deriveAccount44(this.account);

  i = this.receiveDepth;
  while (i--)
    this.createReceive();

  i = this.changeDepth;
  while (i--)
    this.createChange();
};

MemWallet.prototype.createReceive = function createReceive() {
  var index = this.receiveDepth++;
  var key = this.deriveReceive(index);
  var hash = key.getHash('hex');
  this.filter.add(hash, 'hex');
  this.paths[hash] = new Path(hash, 0, index);
  this.receive = key;
  return key;
};

MemWallet.prototype.createChange = function createChange() {
  var index = this.changeDepth++;
  var key = this.deriveChange(index);
  var hash = key.getHash('hex');
  this.filter.add(hash, 'hex');
  this.paths[hash] = new Path(hash, 1, index);
  this.change = key;
  return key;
};

MemWallet.prototype.deriveReceive = function deriveReceive(index) {
  return this.deriveKey(0, index);
};

MemWallet.prototype.deriveChange = function deriveChange(index) {
  return this.deriveKey(1, index);
};

MemWallet.prototype.derivePath = function derivePath(path) {
  return this.deriveKey(path.branch, path.index);
};

MemWallet.prototype.deriveKey = function deriveKey(branch, index) {
  var key = this.master.deriveAccount44(this.account);
  key = key.derive(branch).derive(index);
  key = new KeyRing({
    network: this.network,
    privateKey: key.privateKey,
    witness: this.witness
  });
  key.witness = this.witness;
  return key;
};

MemWallet.prototype.getKey = function getKey(hash) {
  var path = this.paths[hash];
  if (!path)
    return;
  return this.derivePath(path);
};

MemWallet.prototype.getPath = function getPath(hash) {
  return this.paths[hash];
};

MemWallet.prototype.getCoin = function getCoin(key) {
  return this.coins[key];
};

MemWallet.prototype.getUndo = function getUndo(key) {
  return this.spent[key];
};

MemWallet.prototype.addCoin = function addCoin(coin) {
  var op = Outpoint(coin.hash, coin.index);
  var key = op.toKey();

  this.filter.add(op.toRaw());

  delete this.spent[key];

  this.coins[key] = coin;
  this.balance += coin.value;
};

MemWallet.prototype.removeCoin = function removeCoin(key) {
  var coin = this.coins[key];

  if (!coin)
    return;

  this.spent[key] = coin;
  this.balance -= coin.value;

  delete this.coins[key];
};

MemWallet.prototype.getAddress = function getAddress() {
  return this.receive.getAddress();
};

MemWallet.prototype.getReceive = function getReceive() {
  return this.receive.getAddress();
};

MemWallet.prototype.getChange = function getChange() {
  return this.change.getAddress();
};

MemWallet.prototype.getCoins = function getCoins() {
  return util.values(this.coins);
};

MemWallet.prototype.syncKey = function syncKey(path) {
  switch (path.branch) {
    case 0:
      if (path.index === this.receiveDepth - 1)
        this.createReceive();
      break;
    case 1:
      if (path.index === this.changeDepth - 1)
        this.createChange();
      break;
    default:
      assert(false);
      break;
  }
};

MemWallet.prototype.addBlock = function addBlock(entry, txs, ext) {
  var i, tx;

  for (i = 0; i < txs.length; i++) {
    tx = txs[i];
    this.addTX(tx, entry.height);
  }

  for (i = 0; i < ext.length; i++) {
    tx = ext[i];
    this.addTX(tx, entry.height);
  }
};

MemWallet.prototype.removeBlock = function removeBlock(entry, txs, ext) {
  var i, tx;

  for (i = ext.length - 1; i >= 0; i--) {
    tx = ext[i];
    this.removeTX(tx, entry.height);
  }

  for (i = txs.length - 1; i >= 0; i--) {
    tx = txs[i];
    this.removeTX(tx, entry.height);
  }
};

MemWallet.prototype.addTX = function addTX(tx, height) {
  var hash = tx.hash('hex');
  var result = false;
  var witness = tx.hasWitness();
  var i, op, path, addr, coin, input, output;

  if (height == null)
    height = -1;

  if (this.map[hash])
    return true;

  if (!tx.isCoinbase() && !tx.isResolution()) {
    for (i = 0; i < tx.inputs.length; i++) {
      input = tx.inputs[i];
      op = input.prevout.toKey();
      coin = this.getCoin(op);

      if (!coin)
        continue;

      result = true;

      this.removeCoin(op);
    }
  }

  for (i = 0; i < tx.outputs.length; i++) {
    output = tx.outputs[i];
    addr = output.getHash('hex');

    if (!addr)
      continue;

    path = this.getPath(addr);

    if (!path)
      continue;

    if (witness && !output.script.isProgram())
      continue;

    result = true;
    coin = Coin.fromTX(tx, i, height);

    this.addCoin(coin);
    this.syncKey(path);
  }

  if (result) {
    this.txs++;
    this.map[hash] = true;
  }

  return result;
};

MemWallet.prototype.removeTX = function removeTX(tx, height) {
  var hash = tx.hash('hex');
  var result = false;
  var witness = tx.hasWitness();
  var i, op, coin, input, output;

  if (!this.map[hash])
    return false;

  for (i = 0; i < tx.outputs.length; i++) {
    output = tx.outputs[i];
    op = Outpoint(hash, i).toKey();
    coin = this.getCoin(op);

    if (!coin)
      continue;

    if (witness && !output.script.isProgram())
      continue;

    result = true;

    this.removeCoin(op);
  }

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    op = input.prevout.toKey();
    coin = this.getUndo(op);

    if (!coin)
      continue;

    result = true;

    this.addCoin(coin);
  }

  if (result)
    this.txs--;

  delete this.map[hash];

  return result;
};

MemWallet.prototype.deriveInputs = function deriveInputs(mtx) {
  var keys = [];
  var i, input, coin, addr, path, key;

  for (i = 0; i < mtx.inputs.length; i++) {
    input = mtx.inputs[i];
    coin = mtx.view.getOutput(input);

    if (!coin)
      continue;

    addr = coin.getHash('hex');

    if (!addr)
      continue;

    path = this.getPath(addr);

    if (!path)
      continue;

    key = this.derivePath(path);

    keys.push(key);
  }

  return keys;
};

MemWallet.prototype.fund = function fund(mtx, options) {
  var coins = this.getCoins();

  if (!options)
    options = {};

  return mtx.fund(coins, {
    selection: options.selection || 'age',
    round: options.round,
    depth: options.depth,
    hardFee: options.hardFee,
    subtractFee: options.subtractFee,
    changeAddress: this.getChange(),
    height: -1,
    rate: options.rate,
    maxFee: options.maxFee
  });
};

MemWallet.prototype.template = function template(mtx) {
  var keys = this.deriveInputs(mtx);
  mtx.template(keys);
};

MemWallet.prototype.sign = function sign(mtx) {
  var keys = this.deriveInputs(mtx);
  mtx.template(keys);
  mtx.sign(keys);
};

MemWallet.prototype.create = co(function* create(options) {
  var mtx = new MTX(options);
  var tx;

  yield this.fund(mtx, options);

  assert(mtx.getFee() <= MTX.Selector.MAX_FEE, 'TX exceeds MAX_FEE.');

  mtx.sortMembers();

  if (options.locktime != null)
    mtx.setLocktime(options.locktime);

  this.sign(mtx);

  if (!mtx.isSigned())
    throw new Error('Cannot sign tx.');

  return mtx;
});

MemWallet.prototype.send = co(function* send(options) {
  var mtx = yield this.create(options);
  this.addTX(mtx.toTX());
  return mtx;
});

function Path(hash, branch, index) {
  this.hash = hash;
  this.branch = branch;
  this.index = index;
}

module.exports = MemWallet;
