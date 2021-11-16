/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const adapterName = require('./package.json').name.split('.').pop();

class OctoPrint extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: adapterName,
        });

        this.supportedVersion = '1.7.2';
        this.apiConnected = false;
        this.systemCommands = [];

        /*
            - API not connected
            - Closed
            - Detecting serial connection
            - Operational
            - Printing
        */
        this.printerStatus = 'API not connected';

        this.refreshStateTimeout = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.subscribeStates('*');
        this.setPrinterState(false);

        if (!this.config.octoprintApiKey) {
            this.log.warn('API key not configured. Check configuration of instance ' + this.namespace);
        }

        if (this.config.customName) {
            this.setStateAsync('name', {val: this.config.customName, ack: true});
        } else {
            this.setStateAsync('name', {val: '', ack: true});
        }

        this.log.debug('Starting with API refresh interval: ' + this.config.apiRefreshInterval + ' (' + this.config.apiRefreshIntervalPrinting + ' while printing)');

        // Delete old (unused) namespace on startup
        await this.delObjectAsync('temperature', {recursive: true});

        this.refreshState('onReady', true);
    }

    onUnload(callback) {
        try {
            this.setPrinterState(false);

            if (this.refreshStateTimeout) {
                this.log.debug('clearing refresh state timeout');
                clearTimeout(this.refreshStateTimeout);
            }

            this.log.debug('cleaned everything up...');
            callback();
        } catch (e) {
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
            const cleanId = this.removeNamespace(id);

            // No ack = changed by user
            if (this.apiConnected) {
                if (id.match(new RegExp(this.namespace + '.tools.tool[0-9]{1}.(targetTemperature|extrude)'))) {

                    const matches = id.match(/.+\.tools\.(tool[0-9]{1})\.(targetTemperature|extrude)$/);
                    const toolId = matches[1];
                    const command = matches[2];

                    if (command === 'targetTemperature') {
                        this.log.debug('changing target "' + toolId + '" temperature to ' + state.val);

                        let targetObj = {};
                        targetObj[toolId] = state.val;

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-a-tool-command
                        this.buildRequest(
                            'printer/tool',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 400 Bad Request – If targets or offsets contains a property or tool contains a value not matching the format tool{n}, the target/offset temperature, extrusion amount or flow rate factor is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                    // 409 Conflict – If the printer is not operational or – in case of select or extrude – currently printing.

                                    this.log.error('(printer/tool): ' + status + ': ' + JSON.stringify(content));
                                }
                            },
                            {
                                command: 'target',
                                targets: targetObj
                            }
                        );
                    } else if (command === 'extrude') {
                        this.log.debug('extruding ' + state.val + 'mm');

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-a-tool-command
                        this.buildRequest(
                            'printer/tool',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 400 Bad Request – If targets or offsets contains a property or tool contains a value not matching the format tool{n}, the target/offset temperature, extrusion amount or flow rate factor is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                    // 409 Conflict – If the printer is not operational or – in case of select or extrude – currently printing.

                                    this.log.error('(printer/tool): ' + status + ': ' + JSON.stringify(content));
                                }
                            },
                            {
                                command: 'extrude',
                                amount: state.val
                            }
                        );
                    }

                } else if (id === this.namespace + '.tools.bed.targetTemperature') {

                    this.log.debug('changing target bed temperature to ' + state.val);

                    // https://docs.octoprint.org/en/master/api/printer.html#issue-a-bed-command
                    this.buildRequest(
                        'printer/bed',
                        (content, status) => {
                            if (status == 204) {
                                this.setStateAsync(cleanId, {val: state.val, ack: true});
                            } else {
                                // 400 Bad Request – If target or offset is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                // 409 Conflict – If the printer is not operational or the selected printer profile does not have a heated bed.

                                this.log.error('(printer/bed): ' + status + ': ' + JSON.stringify(content));
                            }
                        },
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

                        // https://docs.octoprint.org/en/master/api/connection.html#issue-a-connection-command
                        this.buildRequest(
                            'connection',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, {val: state.val, ack: true});
                                    this.refreshState('onStateChange command.printer', false);
                                } else {
                                    // 400 Bad Request – If the selected port or baudrate for a connect command are not part of the available options.

                                    this.log.error('(connection): ' + status + ': ' + JSON.stringify(content));
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else if (allowedCommandsPrinter.indexOf(state.val) > -1) {
                        this.log.debug('sending printer command: ' + state.val);

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-a-print-head-command
                        this.buildRequest(
                            'printer/printhead',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                    // 409 Conflict – If the printer is not operational or currently printing.

                                    this.log.error('(printer/printhead): ' + status + ': ' + JSON.stringify(content));
                                }
                            },
                            {
                                command: state.val,
                                axes: ['x', 'y', 'z']
                            }
                        );
                    } else {
                        this.log.error('printer command not allowed: ' + state.val + '. Choose one of: ' + allowedCommandsConnection.concat(allowedCommandsPrinter).join(', '));
                    }

                } else if (id === this.namespace + '.command.printjob') {

                    const allowedCommands = ['start', 'cancel', 'restart'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending printjob command: ' + state.val);

                        // https://docs.octoprint.org/en/master/api/job.html#issue-a-job-command
                        this.buildRequest(
                            'job',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 409 Conflict – If the printer is not operational or the current print job state does not match the preconditions for the command.

                                    this.log.error('(job): ' + status + ': ' + JSON.stringify(content));
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('print job command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }

                } else if (id === this.namespace + '.command.sd') {

                    const allowedCommands = ['init', 'refresh', 'release'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending sd card command: ' + state.val);

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-an-sd-command
                        this.buildRequest(
                            'printer/sd',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 409 Conflict – If a refresh or release command is issued but the SD card has not been initialized (e.g. via init).

                                    this.log.error('(printer/sd): ' + status + ': ' + JSON.stringify(content));
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('sd card command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }

                } else if (id === this.namespace + '.command.custom') {

                    this.log.debug('sending custom command: ' + state.val);

                    // https://docs.octoprint.org/en/master/api/printer.html#send-an-arbitrary-command-to-the-printer
                    this.buildRequest(
                        'printer/command',
                        (content, status) => {
                            if (status == 204) {
                                this.setStateAsync(cleanId, {val: state.val, ack: true});
                            } else {
                                // 409 Conflict – If the printer is not operational

                                this.log.error('(printer/command): ' + status + ': ' + JSON.stringify(content));
                            }
                        },
                        {
                            command: state.val
                        }
                    );

                } else if (id === this.namespace + '.command.system') {

                    if (this.systemCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending system command: ' + state.val);

                        // https://docs.octoprint.org/en/master/api/system.html#execute-a-registered-system-command
                        this.buildRequest(
                            'system/commands/' + state.val,
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 400 Bad Request – If a divider is supposed to be executed or if the request is malformed otherwise
                                    // 404 Not Found – If the command could not be found for source and action
                                    // 500 Internal Server Error – If the command didn’t define a command to execute, the command returned a non-zero return code and ignore was not true or some other internal server error occurred

                                    this.log.error('(system/commands): ' + status + ': ' + JSON.stringify(content));
                                }
                            },
                            {}
                        );
                    } else {
                        this.log.error('system command not allowed: ' + state.val + '. Choose one of: ' + this.systemCommands.join(', '));
                    }
                } else if (id.indexOf(this.namespace + '.command.jog.') === 0) {

                    const axis = id.split('.').pop(); // Last element of the id is the axis
                    const jogCommand = {
                        command: 'jog',
                    };

                    // Add axis
                    jogCommand[axis] = state.val;

                    this.log.debug('sending jog ' + axis + ' command: ' + state.val);

                    // https://docs.octoprint.org/en/master/api/printer.html#issue-a-print-head-command
                    this.buildRequest(
                        'printer/printhead',
                        (content, status) => {
                            if (status == 204) {
                                this.setStateAsync(cleanId, {val: state.val, ack: true});
                            } else {
                                // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                // 409 Conflict – If the printer is not operational or currently printing.

                                this.log.error('(printer/printhead): ' + status + ': ' + JSON.stringify(content));
                            }
                        },
                        jogCommand
                    );
                } else if (id.match(new RegExp(this.namespace + '.files.[a-zA-Z0-9_]+.(select|print)'))) {
                    const matches = id.match(/.+\.files\.([a-zA-Z0-9_]+)\.(select|print)$/);
                    const fileId = matches[1];
                    const action = matches[2];

                    this.log.debug('selecting/printing file ' + fileId + ' - action: ' + action);

                    this.getState(
                        'files.' + fileId + '.path',
                        (err, state) => {
                            const fullPath = state.val;

                            this.log.debug('selecting/printing file with path ' + fullPath);

                            // https://docs.octoprint.org/en/master/api/files.html#issue-a-file-command
                            this.buildRequest(
                                'files/' + fullPath,
                                (content, status) => {
                                    if (status == 204) {
                                        this.log.debug('selection/print file successful');
                                        this.refreshState('onStateChange file.' + action, false);
                                    } else {
                                        this.log.error('(files): ' + status + ': ' + JSON.stringify(content));
                                    }
                                },
                                {
                                    command: 'select',
                                    print: (action == 'print')
                                }
                            );
                        }
                    );
                }
            }
        }
    }

    setPrinterState(connection) {
        this.setStateAsync('info.connection', connection, true);
        this.apiConnected = connection;

        if (!connection) {
            this.printerStatus = 'API not connected';
            this.setStateAsync('printer_status', {val: this.printerStatus, ack: true});
        }
    }

    async refreshState(source, refreshFileList) {
        this.log.debug('refreshing state: started from ' + source);

        // https://docs.octoprint.org/en/master/api/version.html
        this.buildRequest(
            'version',
            (content, status) => {
                if (status == 200) {
                    this.setPrinterState(true);

                    this.log.debug('connected to OctoPrint API - online! - status: ' + status);

                    this.setStateAsync('meta.version', {val: content.server, ack: true});
                    this.setStateAsync('meta.api_version', {val: content.api, ack: true});

                    if (this.isNewerVersion(content.server, this.supportedVersion)) {
                        this.log.warn('You should update your OctoPrint installation - supported version of this adapter is ' + this.supportedVersion + ' (or later). Your current version is ' + content.server);
                    }

                    this.refreshStateDetails();

                    if (refreshFileList) {
                        this.refreshFiles();
                    } else {
                        this.log.debug('skipped file list refresh');
                    }
                } else {
                    this.log.error('(version): ' + status + ': ' + JSON.stringify(content));
                }
            },
            null
        );

        if (!this.apiConnected) {
            const notConnectedTimeout = 10;
            this.log.debug('refreshing state: re-creating refresh timeout (API not connected) - seconds: ' + notConnectedTimeout);
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (API not connected)', true);
            }, notConnectedTimeout * 1000);
        } else if (this.printerStatus == 'Printing') {
            this.log.debug('refreshing state: re-creating refresh timeout (printing) - seconds: ' + this.config.apiRefreshIntervalPrinting);
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (printing)', false);
            }, this.config.apiRefreshIntervalPrinting * 1000); // Default 10 sec
        } else if (this.printerStatus == 'Operational') {
            this.log.debug('refreshing state: re-creating refresh timeout (operational) - seconds: ' + this.config.apiRefreshIntervalOperational);
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (operational)', true);
            }, this.config.apiRefreshIntervalOperational * 1000); // Default 30 sec
        } else {
            this.log.debug('refreshing state: re-creating state timeout (default) - seconds: ' + this.config.apiRefreshInterval);
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (default)', true);
            }, this.config.apiRefreshInterval * 1000); // Default 60 sec
        }
    }

    async refreshStateDetails() {
        if (this.apiConnected) {

            // https://docs.octoprint.org/en/master/api/connection.html
            this.buildRequest(
                'connection',
                (content, status) => {
                    if (status == 200) {
                        this.printerStatus = content.current.state;
                        this.setStateAsync('printer_status', {val: this.printerStatus, ack: true});

                        // Try again in 2 seconds
                        if (this.printerStatus === 'Detecting serial connection') {
                            setTimeout(() => {
                                this.refreshState('detecting serial connection', false);
                            }, 2000);
                        }
                    } else {
                        this.log.error('(connection): ' + status + ': ' + JSON.stringify(content));
                    }
                },
                null
            );

            this.buildRequest(
                'printer',
                async (content, status) => {
                    if (typeof content === 'object' && Object.prototype.hasOwnProperty.call(content, 'temperature')) {
                        for (const key of Object.keys(content.temperature)) {
                            const obj = content.temperature[key];

                            const isTool = key.indexOf('tool') > -1;
                            const isBed = key == 'bed';

                            if (isTool || isBed) { // Tool + bed information

                                // Create tool channel
                                await this.setObjectNotExistsAsync('tools.' + key, {
                                    type: 'channel',
                                    common: {
                                        name: key,
                                    },
                                    native: {}
                                });

                                // Set actual temperature
                                await this.setObjectNotExistsAsync('tools.' + key + '.actualTemperature', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'Actual temperature',
                                            de: 'Tatsächliche Temperatur',
                                            ru: 'Фактическая температура',
                                            pt: 'Temperatura real',
                                            nl: 'Werkelijke temperatuur',
                                            fr: 'Température réelle',
                                            it: 'Temperatura effettiva',
                                            es: 'Temperatura real',
                                            pl: 'Rzeczywista temperatura',
                                            'zh-cn': '实际温度'
                                        },
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('tools.' + key + '.actualTemperature', {val: obj.actual, ack: true});

                                // Set target temperature
                                await this.setObjectNotExistsAsync('tools.' + key + '.targetTemperature', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'Target temperature',
                                            de: 'Zieltemperatur',
                                            ru: 'Целевая температура',
                                            pt: 'Temperatura alvo',
                                            nl: 'Doeltemperatuur',
                                            fr: 'Température cible',
                                            it: 'Temperatura obiettivo',
                                            es: 'Temperatura objetivo',
                                            pl: 'Temperatura docelowa',
                                            'zh-cn': '目标温度'
                                        },
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: true
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('tools.' + key + '.targetTemperature', {val: obj.target, ack: true});

                                // Set offset temperature
                                await this.setObjectNotExistsAsync('tools.' + key + '.offsetTemperature', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'Offset temperature',
                                            de: 'Offset-Temperatur',
                                            ru: 'Смещение температуры',
                                            pt: 'Temperatura compensada',
                                            nl: 'Offset temperatuur',
                                            fr: 'Température de décalage',
                                            it: 'Temperatura di compensazione',
                                            es: 'Temperatura de compensación',
                                            pl: 'Temperatura przesunięcia',
                                            'zh-cn': '偏移温度'
                                        },
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('tools.' + key + '.offsetTemperature', {val: obj.target, ack: true});
                            }

                            if (isTool) {
                                // Set extrude
                                await this.setObjectNotExistsAsync('tools.' + key + '.extrude', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'Extrude',
                                            de: 'Extrudieren',
                                            ru: 'Выдавливание',
                                            pt: 'Extrudar',
                                            nl: 'extruderen',
                                            fr: 'Extruder',
                                            it: 'Estrudere',
                                            es: 'Extrudir',
                                            pl: 'Wyrzucać',
                                            'zh-cn': '拉伸'
                                        },
                                        type: 'number',
                                        role: 'value',
                                        unit: 'mm',
                                        read: true,
                                        write: true
                                    },
                                    native: {}
                                });
                            }
                        }
                    }
                },
                null
            );

            this.buildRequest(
                'system/commands',
                (content, status) => {
                    this.systemCommands = [];

                    for (const key of Object.keys(content)) {
                        const arr = content[key];
                        arr.forEach(e => this.systemCommands.push(e.source + '/' + e.action));
                    }

                    this.log.debug('Registered system commands: ' + this.systemCommands.join(', '));
                },
                null
            );

            if (this.printerStatus == 'Printing') {
                this.buildRequest(
                    'job',
                    (content, status) => {
                        if (Object.prototype.hasOwnProperty.call(content, 'error')) {
                            this.log.warn('print job error: ' + content.error);
                        }

                        if (Object.prototype.hasOwnProperty.call(content, 'job') && Object.prototype.hasOwnProperty.call(content.job, 'file')) {
                            this.setStateAsync('printjob.file.name', {val: content.job.file.name, ack: true});
                            this.setStateAsync('printjob.file.origin', {val: content.job.file.origin, ack: true});
                            this.setStateAsync('printjob.file.size', {val: Number((content.job.file.size / 1024).toFixed(2)), ack: true});
                            this.setStateAsync('printjob.file.date', {val: new Date(content.job.file.date * 1000).getTime(), ack: true});

                            if (Object.prototype.hasOwnProperty.call(content.job, 'filament') && content.job.filament) {
                                let filamentLength = 0;
                                let filamentVolume = 0;

                                if (Object.prototype.hasOwnProperty.call(content.job.filament, 'tool0') && content.job.filament.tool0) {
                                    filamentLength = Object.prototype.hasOwnProperty.call(content.job.filament.tool0, 'length') ? content.job.filament.tool0.length : 0;
                                    filamentVolume = Object.prototype.hasOwnProperty.call(content.job.filament.tool0, 'volume') ? content.job.filament.tool0.volume : 0;
                                } else {
                                    filamentLength = Object.prototype.hasOwnProperty.call(content.job.filament, 'length') ? content.job.filament.length : 0;
                                    filamentVolume = Object.prototype.hasOwnProperty.call(content.job.filament, 'volume') ? content.job.filament.volume : 0 ;
                                }

                                if (typeof filamentLength == 'number' && typeof filamentVolume == 'number') {
                                    this.setStateAsync('printjob.filament.length', {val: Number((filamentLength / 1000).toFixed(2)), ack: true});
                                    this.setStateAsync('printjob.filament.volume', {val: Number((filamentVolume).toFixed(2)), ack: true});
                                } else {
                                    this.log.debug('Filament length and/or volume contains no valid number');

                                    this.setStateAsync('printjob.filament.length', 0, true);
                                    this.setStateAsync('printjob.filament.volume', 0, true);
                                }
                            } else {
                                this.setStateAsync('printjob.filament.length', 0, true);
                                this.setStateAsync('printjob.filament.volume', 0, true);
                            }
                        }

                        if (Object.prototype.hasOwnProperty.call(content, 'progress')) {
                            this.setStateAsync('printjob.progress.completion', {val: Math.round(content.progress.completion), ack: true});
                            this.setStateAsync('printjob.progress.filepos', {val: Number((content.progress.filepos / 1024).toFixed(2)), ack: true});
                            this.setStateAsync('printjob.progress.printtime', {val: content.progress.printTime, ack: true});
                            this.setStateAsync('printjob.progress.printtime_left', {val: content.progress.printTimeLeft, ack: true});
                        }
                    },
                    null
                );
            } else {
                this.log.debug('refreshing job state: skipped detail refresh (not printing)');
            }
        } else {
            this.log.debug('refreshing state: skipped detail refresh (API not connected)');
        }
    }

    flattenFiles(files) {

        let fileArr = [];

        if (Array.isArray(files)) {
            for (const file of files) {

                if (file.type == 'machinecode' && file.origin == 'local') {

                    fileArr.push(
                        {
                            name: file.display,
                            path: file.origin + '/' + file.path,
                            date: (file.date) ? new Date(file.date * 1000).getTime() : 0,
                            size: (file.size) ? Math.round(file.size / 1024) : 0
                        }
                    );

                } else if (file.type == 'folder') {
                    fileArr = fileArr.concat(this.flattenFiles(file.children));
                }

            }
        }

        return fileArr;
    }

    async refreshFiles() {

        if (this.apiConnected) {
            this.log.debug('refreshing file list: started');

            this.buildRequest(
                'files?recursive=true',
                (content, status) => {

                    this.getChannelsOf(
                        'files',
                        async (err, states) => {

                            const filesAll = [];
                            const filesKeep = [];

                            // Collect all files
                            if (states) {
                                for (let i = 0; i < states.length; i++) {
                                    const id = this.removeNamespace(states[i]._id);

                                    // Check if the state is a direct child (e.g. files.2)
                                    if (id.split('.').length === 2) {
                                        filesAll.push(id);
                                    }
                                }
                            }

                            const fileList = this.flattenFiles(content.files);
                            this.log.debug('Found ' + fileList.length + ' files');

                            for (const f in fileList) {
                                const file = fileList[f];
                                const fileNameClean = this.cleanNamespace(file.path.replace('.gcode', '').replace('/', ' '));

                                this.log.debug('Found file (clean name): ' + fileNameClean + ' - from: ' + file.path);
                                filesKeep.push('files.' + fileNameClean);

                                await this.setObjectNotExistsAsync('files.' + fileNameClean, {
                                    type: 'channel',
                                    common: {
                                        name: file.name,
                                    },
                                    native: {}
                                });

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.name', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'File name',
                                            de: 'Dateiname',
                                            ru: 'Имя файла',
                                            pt: 'Nome do arquivo',
                                            nl: 'Bestandsnaam',
                                            fr: 'Nom de fichier',
                                            it: 'Nome del file',
                                            es: 'Nombre del archivo',
                                            pl: 'Nazwa pliku',
                                            'zh-cn': '文档名称'
                                        },
                                        type: 'string',
                                        role: 'value',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('files.' + fileNameClean + '.name', {val: file.name, ack: true});

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.path', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'File path',
                                            de: 'Dateipfad',
                                            ru: 'Путь файла',
                                            pt: 'Caminho de arquivo',
                                            nl: 'Bestandspad',
                                            fr: 'Chemin du fichier',
                                            it: 'Percorso del file',
                                            es: 'Ruta de archivo',
                                            pl: 'Ścieżka pliku',
                                            'zh-cn': '文件路径'
                                        },
                                        type: 'string',
                                        role: 'value',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('files.' + fileNameClean + '.path', {val: file.path, ack: true});

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.size', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'File size',
                                            de: 'Dateigröße',
                                            ru: 'Размер файла',
                                            pt: 'Tamanho do arquivo',
                                            nl: 'Bestandsgrootte',
                                            fr: 'Taille du fichier',
                                            it: 'Dimensione del file',
                                            es: 'Tamaño del archivo',
                                            pl: 'Rozmiar pliku',
                                            'zh-cn': '文件大小'
                                        },
                                        type: 'number',
                                        role: 'value',
                                        unit: 'kB',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('files.' + fileNameClean + '.size', {val: file.size, ack: true});

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.date', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'File date',
                                            de: 'Dateidatum',
                                            ru: 'Дата файла',
                                            pt: 'Data do arquivo',
                                            nl: 'Bestandsdatum',
                                            fr: 'Date du fichier',
                                            it: 'Data file',
                                            es: 'Fecha de archivo',
                                            pl: 'Data pliku',
                                            'zh-cn': '文件日期'
                                        },
                                        type: 'number',
                                        role: 'date',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('files.' + fileNameClean + '.date', {val: file.date, ack: true});

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.select', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'Select file',
                                            de: 'Datei auswählen',
                                            ru: 'Выберите файл',
                                            pt: 'Selecione o arquivo',
                                            nl: 'Selecteer bestand',
                                            fr: 'Choisir le dossier',
                                            it: 'Seleziona il file',
                                            es: 'Seleccione Archivo',
                                            pl: 'Wybierz plik',
                                            'zh-cn': '选择文件'
                                        },
                                        type: 'boolean',
                                        role: 'button',
                                        read: false,
                                        write: true
                                    },
                                    native: {}
                                });

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.print', {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'Print',
                                            de: 'Drucken',
                                            ru: 'Распечатать',
                                            pt: 'Imprimir',
                                            nl: 'Afdrukken',
                                            fr: 'Imprimer',
                                            it: 'Stampa',
                                            es: 'Impresión',
                                            pl: 'Wydrukować',
                                            'zh-cn': '打印'
                                        },
                                        type: 'boolean',
                                        role: 'button',
                                        read: false,
                                        write: true
                                    },
                                    native: {}
                                });

                            }

                            // Delete non existent files
                            for (let i = 0; i < filesAll.length; i++) {
                                const id = filesAll[i];

                                if (filesKeep.indexOf(id) === -1) {
                                    this.delObject(id, {recursive: true}, () => {
                                        this.log.debug('refreshing file list: file deleted: "' + id + '"');
                                    });
                                }
                            }
                        }
                    );
                },
                null
            );
        } else {
            this.log.debug('refreshing file list: skipped (API not connected)');
        }
    }

    cleanNamespace(id) {
        return id
            .trim()
            .replace(/\s/g, '_') // Replace whitespaces with underscores
            .replace(/[^\p{Ll}\p{Lu}\p{Nd}]+/gu, '_') // Replace not allowed chars with underscore
            .replace(/[_]+$/g, '') // Remove underscores end
            .replace(/^[_]+/g, '') // Remove underscores beginning
            .replace(/_+/g, '_'); // Replace multiple underscores with one
    }

    removeNamespace(id) {
        const re = new RegExp(this.namespace + '*\.', 'g');
        return id.replace(re, '');
    }

    async buildRequest(service, callback, data) {
        const url = '/api/' + service;
        const method = data ? 'post' : 'get';

        this.log.debug('sending "' + method + '" request to "' + url + '" with data: ' + JSON.stringify(data));

        axios({
            method: method,
            data: data,
            baseURL: 'http://' + this.config.octoprintIp + ':' + this.config.octoprintPort,
            url: url,
            timeout: 2000,
            responseType: 'json',
            headers: {
                'X-Api-Key': this.config.octoprintApiKey
            },
            validateStatus: (status) => {
                return [200, 204, 409].indexOf(status) > -1;
            },
        }).then(response => {
            this.log.debug('received ' + response.status + ' response from ' + url + ' with content: ' + JSON.stringify(response.data));
            // no error - clear up reminder
            delete this.lastErrorCode;

            if (response && callback && typeof callback === 'function') {
                callback(response.data, response.status);
            }
        }).catch(error => {
            if (error.response) {
                // The request was made and the server responded with a status code

                this.log.warn('received error ' + error.response.status + ' response from ' + url + ' with content: ' + JSON.stringify(error.response.data));
            } else if (error.request) {
                // The request was made but no response was received
                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                // http.ClientRequest in node.js

                // avoid spamming of the same error when stuck in a reconnection loop
                if (error.code === this.lastErrorCode) {
                    this.log.debug(error.message);
                } else {
                    this.log.info(error.message);
                    this.lastErrorCode = error.code;
                }

                this.setPrinterState(false);
            } else {
                // Something happened in setting up the request that triggered an Error
                this.log.error(error.message);

                this.setPrinterState(false);
            }
        });
    }

    isNewerVersion(oldVer, newVer) {
        const oldParts = oldVer.split('.');
        const newParts = newVer.split('.');
        for (var i = 0; i < newParts.length; i++) {
            const a = ~~newParts[i]; // parse int
            const b = ~~oldParts[i]; // parse int
            if (a > b) return true;
            if (a < b) return false;
        }
        return false;
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
