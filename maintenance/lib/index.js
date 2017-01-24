"use strict";


var P   = require('bluebird');
var cassandra     = P.promisifyAll(require('cassandra-driver'));
var consistencies = cassandra.types.consistencies;
var fs   = require('fs');
var util = require('util');
var yaml = require('js-yaml');


// A custom retry policy
function AlwaysRetry () {}
util.inherits(AlwaysRetry, cassandra.policies.retry.RetryPolicy);
var ARP = AlwaysRetry.prototype;
// Always retry.
ARP.onUnavailable = function(requestInfo) {
    // Reset the connection
    requestInfo.handler.connection.close(function() {
        requestInfo.handler.connection.open(function(){});
    });
    return { decision: 1 };
};
ARP.onWriteTimeout = function() { return { decision: 2 }; };
ARP.onReadTimeout = function(requestInfo) {
    // Reset the connection
    requestInfo.handler.connection.close(function() {
        requestInfo.handler.connection.open(function(){});
    });
    console.log('read retry');
    return { decision: 1 };
};

function makeClient(options) {
    var creds = options.credentials;
    return new cassandra.Client({
        contactPoints: [options.host],
        authProvider: new cassandra.auth.PlainTextAuthProvider(creds.username, creds.password),
        socketOptions: { connectTimeout: 10000 },
    });
}

function getQuery(tableName, offsets, proj) {
    var cql = 'SELECT ' + proj + ', token("_domain",key) AS "_token" FROM ' + tableName;
    var params = [];
    if (offsets.token) {
        cql += ' WHERE token("_domain",key) = ?';
        params.push(offsets.token);
    } else if (offsets.domain) {
        cql += ' WHERE token("_domain",key) = token(?, ?)';
        params.push(offsets.domain);
        params.push(offsets.key);
    }
    return {
        cql: cql,
        params: params,
    };
}

function nextPage(client, tableName, offsets, proj, retryDelay) {
    //console.log(offsets);
    var query = getQuery(tableName, offsets, proj);
    return client.executeAsync(query.cql, query.params, {
        prepare: true,
        fetchSize: retryDelay ? 1 : 50,
        pageState: offsets.pageState,
        consistency: retryDelay ? consistencies.one : consistencies.one,
    })
    .catch(function(err) {
        retryDelay = retryDelay || 1; // ms
        if (retryDelay < 20 * 1000) {
            retryDelay *= 2 + Math.random();
        } else if (offsets.token) {
            // page over the problematic spot
            console.log('Skipping over problematic token:',
                offsets.token.toString());
            offsets.token = offsets.token.add(500000000);
            console.log('Retrying with new token:',
                offsets.token.toString());
            return nextPage(client, tableName, offsets, proj, retryDelay);
        }

        console.log('Error:', err);
        console.log('PageState:', offsets.pageState);
        console.log('Last token:', offsets.token.toString());
        console.log('Retrying in', Math.round(retryDelay) / 1000, 'seconds...');
        return new P(function(resolve, reject) {
            setTimeout(function() {
                nextPage(client, tableName, offsets, proj, retryDelay)
                    .then(resolve)
                    .catch(reject);
            }, retryDelay);
        });
    });
}

/**
 * Iterate rows in a key-rev-value table.
 *
 * @param {cassandra#Client} client - Cassandra client instance.
 * @param {string}   tableName - Cassandra table name.
 * @param {Object}   offsets   - Offset information (token, domain, key, and pageState).
 * @param {Function} func      - Function called with result rows.
 */
function processRows(client, tableName, offsets, proj, func) {
    return nextPage(client, tableName, offsets, proj)
    .then(function(res) {
        return P.resolve(res.rows)
        .each(func)
        .then(function() {
            process.nextTick(function() {
                offsets.pageState = res.pageState;
                processRows(client, tableName, offsets, proj, func);
            });
        })
        .catch(function(e) {
            console.log(res.pageState);
            console.log(e);
            throw e;
        });
    });
}

/**
 * Iterate rows in a key-rev-value table.
 *
 * @param {cassandra#Client} client - Cassandra client instance.
 * @param {array}   tables   - Cassandra table names.
 * @param {Object}   offset - Offset information (token, domain, key, and pageState).
 * @param {string}  proj  - The projetion string on what to select
 * @param {Function} func    - Function called with result rows.
 */
function processRowsMultipleTables(client, tables, offset, proj, func) {
    return P.all(tables.map((tableName) => nextPage(client, tableName, offset, proj)))
    .then(function(results) {
        const aggregated = [];
        for (let i = 0; i < results[0].rows.length; i++) {
            aggregated.push([results[0].rows[i], results[1].rows[i]]);
        }
        return P.resolve(aggregated)
        .each(func)
        .then(function() {
            process.nextTick(function() {
                console.log(offset);
                processRowsMultipleTables(client, tables, offset, proj, func);
            });
        })
        .catch(function(e) {
            console.log(results.map((res) => res.pageState));
            console.log(e);
            throw e;
        });
    });
}

/**
 * Return the table section of a RESTBase config.
 *
 * @param  {string}  config  - Path to a RESTBase YAML configuration file.
 * @return {object}  table section of configuration.
 */
function getConfig(config) {
    // Read a RESTBase configuration from a (optional) path argument, an (optional) CONFIG
    // env var, or from /etc/restbase/config.yaml
    var conf;

    if (config) {
        conf = config;
    } else if (process.env.CONFIG) {
        conf = process.env.CONFIG;
    } else {
        conf = '/etc/restbase/config.yaml';
    }

    var confObj = yaml.safeLoad(fs.readFileSync(conf));
    return confObj.default_project['x-modules'][0].options.table;
}

module.exports = {
    iterateTable: processRows,
    iterateTables: processRowsMultipleTables,
    makeClient: makeClient,
    getConfig: getConfig,
};
