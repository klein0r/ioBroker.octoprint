/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

var utils = require(__dirname + '/lib/utils');
var request = require('request');

var adapter = new utils.Adapter('octoprint');

adapter.on('unload', function (callback) {
    try {
        adapter.setState('info.connection', false, true);
        callback();
    } catch (e) {
        callback();
    }
});

adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    adapter.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
});

adapter.on('stateChange', function (id, state) {
    // Warning, state can be null if it was deleted
    adapter.log.info('stateChange ' + id + ' ' + JSON.stringify(state));

    // you can use the ack flag to detect if it is status (true) or command (false)
    if (state && !state.ack) {
        adapter.log.info('ack is not set!');
    }
});

adapter.on('message', function (obj) {
    if (typeof obj === 'object' && obj.message) {
        if (obj.command === 'send') {
            // e.g. send email or pushover or whatever
            console.log('send command');

            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
});

adapter.on('ready', function () {
    main();
});

function main() {    
    // Refresh State every Minute
    refreshState();
    setInterval(refreshState, 60000);
}

function refreshState()
{
    adapter.log.debug('refreshing OctoPrint state');

    buildRequest(
        'version',
        function(content) {
            adapter.setState('info.connection', true, true);

            adapter.setState('meta.version', {val: content.server, ack: true});
            adapter.setState('meta.api_version', {val: content.api, ack: true});
        },
        null
    );
}

function buildRequest(service, callback, data)
{
    var url = 'http://' + adapter.config.octoprintIp + ':5000/api/' + service;

    adapter.log.info('sending request to ' + url + ' with data: ' + JSON.stringify(data));

    request(
        {
            url: url,
            method: data ? "PUT" : "GET",
            json: data ? data : true,
            headers: {
                "X-Api-Key": adapter.config.octoprintApiKey
            }
        },
        function(error, response, content) {
            if (!error && response.statusCode == 200) {
               callback(content);
            } else if (error) {
                adapter.log.error(error);
            } else {
                adapter.log.error('Status Code: ' + response.statusCode + ' / Content: ' + content);
            }
        }
    );
}