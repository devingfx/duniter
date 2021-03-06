"use strict";
var Q = require('q');
var co = require('co');
var rp     = require('request-promise');
var _ = require('underscore');
var async  = require('async');
var request  = require('request');
var vucoin = require('vucoin');
var ucoin  = require('../../../index');
var multicaster = require('../../../app/lib/streams/multicaster');
var Configuration = require('../../../app/lib/entity/configuration');
var Peer          = require('../../../app/lib/entity/peer');
var user   = require('./user');
var http   = require('./http');

var MEMORY_MODE = true;

module.exports = function (dbName, options) {
  return new Node(dbName, options);
};

let AUTO_PORT = 10200;

module.exports.statics = {

  newBasicTxNode: (testSuite) => () => {
    getTxNode(testSuite);
  },

  newBasicTxNodeWithOldDatabase: (testSuite) => () => {
    getTxNode(testSuite, (node) => co(function*() {
      node.server.dal.txsDAL.exec('UPDATE txs SET recipients = "[]";');
    }));
  }
};

function getTxNode(testSuite, afterBeforeHook){

  let port = ++AUTO_PORT;

  var node2 = new Node({ name: "db_" + port, memory: MEMORY_MODE }, { currency: 'cc', ipv4: 'localhost', port: port, remoteipv4: 'localhost', remoteport: port, upnp: false, httplogs: false,
    pair: {
      pub: 'DNann1Lh55eZMEDXeYt59bzHbA3NJR46DeQYCS2qQdLV',
      sec: '468Q1XtTq7h84NorZdWBZFJrGkB18CbmbHr9tkp9snt5GiERP7ySs3wM8myLccbAAGejgMRC9rqnXuW3iAfZACm7'
    },
    forksize: 3,
    participate: false, rootoffset: 10,
    sigQty: 1, dt: 0, ud0: 120
  });

  var tic = user('tic', { pub: 'DNann1Lh55eZMEDXeYt59bzHbA3NJR46DeQYCS2qQdLV', sec: '468Q1XtTq7h84NorZdWBZFJrGkB18CbmbHr9tkp9snt5GiERP7ySs3wM8myLccbAAGejgMRC9rqnXuW3iAfZACm7'}, node2);
  var toc = user('toc', { pub: 'DKpQPUL4ckzXYdnDRvCRKAm1gNvSdmAXnTrJZ7LvM5Qo', sec: '64EYRvdPpTfLGGmaX5nijLXRqWXaVz8r1Z1GtaahXwVSJGQRn7tqkxLb288zwSYzELMEG5ZhXSBYSxsTsz1m9y8F'}, node2);

  before(() => co(function*() {
    yield node2.startTesting();
    // Self certifications
    yield tic.selfCertP();
    yield toc.selfCertP();
    // Certification;
    yield tic.certP(toc);
    yield toc.certP(tic);
    yield tic.joinP();
    yield toc.joinP();
    yield node2.commitP();
    yield node2.commitP();
    yield tic.sendP(51, toc);

    if (afterBeforeHook) {
      yield afterBeforeHook(node2);
    }
  }));

  after(node2.after());

  node2.rp = (uri) => rp('http://127.0.0.1:' + port + uri, { json: true });

  node2.expectHttp = (uri, callback) => () => http.expectAnswer(node2.rp(uri), callback);

  testSuite(node2);
}

var UNTIL_TIMEOUT = 115000;

function Node (dbName, options) {

  var logger = require('../../../app/lib/logger')(dbName);
  var that = this;
  var started = false;
  that.server = null;
  that.http = null;

  /**
   * To be executed before tests
   * @param scenarios Scenarios to execute: a suite of operations over a node (identities, certs, tx, blocks, ...).
   * @returns {Function} Callback executed by unit test framework.
   */
  this.before = function (scenarios) {
    return function(done) {
      async.waterfall([
        function (next) {
          vucoin(options.remoteipv4, options.remoteport, next);
        },
        function (node, next) {
          that.http = node;
          that.executes(scenarios, next);
        }
      ], done);
    };
  };

  this.executes = function (scenarios, done) {
    async.waterfall([
      function(next) {
        async.forEachSeries(scenarios, function(useCase, callback) {
          useCase(callback);
        }, next);
      }
    ], done);
  };

  /**
   * To be exectued after unit tests. Here: clean the database (removal)
   * @returns {Function} Callback executed by unit test framework.
   */
  this.after = function () {
    return function (done) {
      done();
    };
  };

  /**
   * Generates next block and submit it to local node.
   * @returns {Function}
   */
  this.commit = function() {
    return function(done) {
      async.waterfall([
        function(next) {
          async.parallel({
            block: function(callback){
              that.server.BlockchainService.generateNext().then(_.partial(callback, null)).catch(callback);
            },
            sigFunc: function(callback){
              require('../../../app/lib/signature').sync(that.server.pair, callback);
            }
          }, next);
        },
        function(res, next) {
          var block = res.block;
          var sigFunc = res.sigFunc;
          var pub = that.server.PeeringService.pubkey;
          proveAndSend(that.server, block, sigFunc, pub, block.powMin, next);
        }
      ], function(err, res) {
        done(err, res.body);
      });
    };
  };

  function proveAndSend (server, block, sigFunc, issuer, difficulty, done) {
    var BlockchainService = server.BlockchainService;
    async.waterfall([
      function (next){
        block.issuer = issuer;
        BlockchainService.prove(block, sigFunc, difficulty).then((proven) => next(null, proven)).catch(next);
      },
      function (provenBlock, next){
        if (provenBlock) {
          logger.debug(provenBlock.getRawSigned());
          post('/blockchain/block', {
            "block": provenBlock.getRawSigned()
          }, next);
        }
      }
    ], done);
  }

  function post(uri, data, done) {
    var postReq = request.post({
      "uri": 'http://' + [that.server.conf.remoteipv4, that.server.conf.remoteport].join(':') + uri,
      "timeout": 1000 * 10,
      "json": true
    }, function (err, res, body) {
      done(err, res, body);
    });
    postReq.form(data);
  }
  
  this.startTesting = function(done) {
    return Q.Promise(function(resolve, reject){
      if (started) return done();
      async.waterfall([
        function(next) {
          service(next)();
        },
        function (server, next){
          // Launching server
          that.server = server;
          that.server.start()
            .then(function(){
              if (server.conf.routing) {
                server
                  .pipe(server.router()) // The router asks for multicasting of documents
                  .pipe(multicaster());
              }
              started = true;
              next();
            })
            .catch(next);
        },
        function (next) {
          vucoin(options.remoteipv4, options.remoteport, next);
        },
        function (node, next) {
          that.http = node;
          next();
        }
      ], function(err) {
        err ? reject(err) : resolve(that.server);
        done && done(err);
      });
    })
      .then((server) => server.listenToTheWeb());
  };

  function service(callback) {
    return function () {
      var cbArgs = arguments;
      var dbConf = typeof dbName == 'object' ? dbName : { name: dbName, memory: true };
      var server = ucoin(dbConf, Configuration.statics.complete(options));

      // Initialize server (db connection, ...)
      server.initWithDAL()
        .then(function(){
          //cbArgs.length--;
          cbArgs[cbArgs.length++] = server;
          //cbArgs[cbArgs.length++] = server.conf;
          callback(null, server);
        })
        .catch(function(err){
          server.disconnect();
          throw err;
        });
    };
  }

  /************************
   *    TEST UTILITIES
   ************************/

  this.lookup = function(search, callback) {
    return function(done) {
      async.waterfall([
        function(next) {
          that.http.wot.lookup(search, next);
        }
      ], function(err, res) {
        callback(res, done);
      });
    };
  };

  this.until = function (eventName, count) {
    var counted = 0;
    var max = count == undefined ? 1 : count;
    return Q.Promise(function (resolve, reject) {
      var finished = false;
      that.server.on(eventName, function () {
        counted++;
        if (counted == max) {
          if (!finished) {
            finished = true;
            resolve();
          }
        }
      });
      setTimeout(function() {
        if (!finished) {
          finished = true;
          reject('Received ' + counted + '/' + count + ' ' + eventName + ' after ' + UNTIL_TIMEOUT + ' ms');
        }
      }, UNTIL_TIMEOUT);
    });
  };

  this.current = function(callback) {
    return function(done) {
      async.waterfall([
        function(next) {
          that.http.blockchain.current(next);
        }
      ], function(err, current) {
        callback(current, done);
      });
    };
  };

  this.block = function(number, callback) {
    return function(done) {
      async.waterfall([
        function(next) {
          that.http.blockchain.block(number, next);
        }
      ], function(err, block) {
        callback(block, done);
      });
    };
  };

  this.summary = function(callback) {
    return function(done) {
      async.waterfall([
        function(next) {
          that.http.node.summary(next);
        }
      ], function(err, summary) {
        callback(summary, done);
      });
    };
  };

  this.sourcesOf = function(pub, callback) {
    return function(done) {
      async.waterfall([
        function(next) {
          that.http.tx.sources(pub, next);
        }
      ], function(err, res) {
        callback(res, done);
      });
    };
  };

  this.sourcesOfP = (pub) => Q.nbind(that.http.tx.sources, that)(pub);

  this.peering = function(done) {
    that.http.network.peering.get(done);
  };

  this.peeringP = () => Q.nfcall(this.peering);

  this.submitPeer = function(peer, done) {
    post('/network/peering/peers', {
      "peer": Peer.statics.peerize(peer).getRawSigned()
    }, done);
  };

  this.submitPeerP = (peer) => Q.nfcall(this.submitPeer, peer);

  this.commitP = () => Q.nfcall(this.commit());
}
