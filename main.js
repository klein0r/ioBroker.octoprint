/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core');
const request = require('request');

class OctoPrint extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'octoprint',
        });

        this.refreshStateTimeout = null;
        this.connected = false;
        this.printerStatus = 'Disconnected';

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.subscribeStates('*');
        this.setState('printer_status', {val: this.printerStatus, ack: true});

        // Refresh State every Minute
        this.refreshState();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setPrinterOffline(false);

            if (this.refreshStateTimeout) {
                this.log.debug('clearing refresh state timeout');
                clearTimeout(this.refreshStateTimeout);
            }

            this.log.debug('cleaned everything up...');
            callback();
        } catch {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state && !state.ack) {
            // No ack = changed by user
            if (this.connected) {
                if (id.match(new RegExp(this.namespace + '.temperature.tool[0-9]{1}.target'))) {
                    this.log.debug('changing target tool temperature to ' + state.val);

                    // TODO: Check which tool has been changed
                    this.buildRequest(
                        'printer/tool',
                        null,
                        {
                            command: 'target',
                            targets: {
                                tool0: state.val
                            }
                        }
                    );
                } else if (id === this.namespace + '.temperature.bed.target') {
                    this.log.debug('changing target bed temperature to ' + state.val);

                    this.buildRequest(
                        'printer/bed',
                        null,
                        {
                            command: 'target',
                            target: state.val
                        }
                    );
                } else if (id === this.namespace + '.command.printer') {

                    const allowedCommandsConnection = ['connect', 'disconnect', 'fake_ack'];
                    const allowedCommandsPrinter = ['home'];

                    if (allowedCommandsConnection.indexOf(state.val) > -1) {
                        this.log.debug('sending printer connection command: ' + state.val);

                        this.buildRequest(
                            'connection',
                            null,
                            {
                                command: state.val
                            }
                        );
                    } else if (allowedCommandsPrinter.indexOf(state.val) > -1) {
                        this.log.debug('sending printer command: ' + state.val);

                        this.buildRequest(
                            'printer/printhead',
                            null,
                            {
                                command: state.val,
                                axes: ['x', 'y', 'z']
                            }
                        );
                    } else {
                        this.log.error('printer command not allowed: ' + state.val);
                    }
                } else if (id === this.namespace + '.command.printjob') {

                    const allowedCommands = ['start', 'cancel', 'restart', 'pause'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending printer command: ' + state.val);

                        this.buildRequest(
                            'job',
                            null,
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('print job command not allowed: ' + state.val);
                    }

                }
            } else {
                this.log.error('OctoPrint API not connected');
            }
        }
    }

    setPrinterOffline(connection) {
        this.setState('info.connection', connection, true);
        this.connected = connection;

        if (!connection) {
            this.printerStatus = 'Disconnected';
            this.setState('printer_status', {val: this.printerStatus, ack: true});
        }
    }

    refreshState() {
        this.log.debug('refreshing OctoPrint state');

        this.buildRequest(
            'version',
            content => {
                this.setState('info.connection', true, true);
                this.connected = true;

                this.setState('meta.version', {val: content.server, ack: true});
                this.setState('meta.api_version', {val: content.api, ack: true});
            },
            null
        );

        if (this.connected) {
            this.buildRequest(
                'connection',
                content => {
                    this.printerStatus = content.current.state;
                    this.setState('printer_status', {val: this.printerStatus, ack: true});
                },
                null
            );

            this.buildRequest(
                'printer',
                async content => {
                    for (const key of Object.keys(content.temperature)) {
                        const obj = content.temperature[key];

                        if (key.indexOf('tool') > -1 || key == 'bed') { // Tool + bed information

                            // Create tool channel
                            try {
                                await this.setObjectNotExistsAsync('temperature.' + key, {
                                    type: 'channel',
                                    common: {
                                        name: key,
                                    },
                                    native: {}
                                });

                                // Set actual temperature
                                await this.setObjectNotExistsAsync('temperature.' + key + '.actual', {
                                    type: 'state',
                                    common: {
                                        name: 'Actual',
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });

                                // Set target temperature
                                await this.setObjectNotExistsAsync('temperature.' + key + '.target', {
                                    type: 'state',
                                    common: {
                                        name: 'Target',
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: true
                                    },
                                    native: {}
                                });

                                // Set offset temperature
                                await this.setObjectNotExistsAsync('temperature.' + key + '.offset', {
                                    type: 'state',
                                    common: {
                                        name: 'Offset',
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                            } catch (e) {
                                this.log.error(`Could not create temperature objects: ${e}`);
                            }

                            this.setState('temperature.' + key + '.actual', {val: obj.actual, ack: true});
                            this.setState('temperature.' + key + '.target', {val: obj.target, ack: true});
                            this.setState('temperature.' + key + '.offset', {val: obj.target, ack: true});
                        }
                    }
                },
                null
            );

            this.buildRequest(
                'job',
                content => {
                    if (content.job) {
                        this.setState('printjob.file.name', {val: content.job.file.name, ack: true});
                        this.setState('printjob.file.origin', {val: content.job.file.origin, ack: true});
                        this.setState('printjob.file.size', {val: content.job.file.size, ack: true});
                        this.setState('printjob.file.date', {val: content.job.file.date, ack: true});

                        if (content.job.filament) {
                            this.setState('printjob.filament.length', {val: content.job.filament.length, ack: true});
                            this.setState('printjob.filament.volume', {val: content.job.filament.volume, ack: true});
                        }
                    }

                    if (content.progress) {
                        this.setState('printjob.progress.completion', {val: content.progress.completion, ack: true});
                        this.setState('printjob.progress.filepos', {val: content.progress.filepos, ack: true});
                        this.setState('printjob.progress.printtime', {val: content.progress.printTime, ack: true});
                        this.setState('printjob.progress.printtime_left', {val: content.progress.printTimeLeft, ack: true});
                    }
                },
                null
            );
        }

        this.log.debug('re-creating refresh state timeout');
        this.refreshStateTimeout = setTimeout(this.refreshState.bind(this), 60000);
    }

    buildRequest(service, callback, data) {
        const url = 'http://' + this.config.octoprintIp + ':' + this.config.octoprintPort + '/api/' + service;
        const self = this;

        this.log.debug('sending request to ' + url + ' with data: ' + JSON.stringify(data));

        request(
            {
                url: url,
                method: data ? 'POST' : 'GET',
                json: data ? data : true,
                headers: {
                    'X-Api-Key': this.config.octoprintApiKey
                }
            },
            (error, response, content) => {
                if (!error && response.statusCode == 409) { // Printer is not operational
                    self.setPrinterOffline(true);
                } else if (!error && (response.statusCode == 200 || response.statusCode == 204)) {
                    if (callback && typeof callback === 'function') {
                        callback(content);
                    }
                } else if (error) {
                    self.log.debug(error);

                    self.setPrinterOffline(false);
                } else {
                    self.log.debug('Status Code: ' + response.statusCode + ' / Content: ' + content);

                    self.setPrinterOffline(false);
                }
            }
        );
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new OctoPrint(options);
} else {
    // otherwise start the instance directly
    new OctoPrint();
}
