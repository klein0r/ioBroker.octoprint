'use strict';

// https://github.com/OllisGit/OctoPrint-DisplayLayerProgress

/*
{
  "currentFilename": "AE10_xyzCalibration_cube.gcode",
  "fanSpeed": "69%",
  "feedrate": "3000",
  "feedrateG0": "3000",
  "feedrateG1": "953.8",
  "height": {
    "current": "8.00",
    "currentFormatted": "8"
    "total": "15.00",
    "totalFormatted": "15",
    "totalWithExtrusion": "10.0",  //DEPRECATED don't use it will be removed in version 1.19.0
    "totalWithExtrusionFormatted": "10"  //DEPRECATED don't use it will be removed in version 1.19.0
  },
  "layer": {
    "averageLayerDuration": "0h:01m:03s",
    "averageLayerDurationInSeconds": 63,
    "current": "39",
    "lastLayerDuration": "0h:00m:58s",
    "lastLayerDurationInSeconds": 58,
    "total": "49"
  },
  "print": {
    "printerState": "printing",
    "progress": "73",
    "m73progress": "86",
    "timeLeft": "40s",
    "timeLeftInSeconds": 40,
    "estimatedEndTime": "20:24",
    "changeFilamentCount": 3,
    "changeFilamentTimeLeft": "32s",
    "changeFilamentTimeLeftInSeconds": 32,
    "estimatedChangedFilamentTime": "22:36",
  }
}
*/

async function refreshValues(adapter) {
    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress', {
        type: 'channel',
        common: {
            name: 'Display Layer Progress',
        },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer', {
        type: 'channel',
        common: {
            name: {
                en: 'Layer',
                de: 'Schicht',
                ru: 'Слой',
                pt: 'Camada',
                nl: 'Laag',
                fr: 'Couche',
                it: 'Strato',
                es: 'Capa',
                pl: 'Warstwa',
                uk: 'Р',
                'zh-cn': '层',
            },
        },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer.current', {
        type: 'state',
        common: {
            name: {
                en: 'Current layer',
                de: 'Aktuelle Ebene',
                ru: 'Текущий слой',
                pt: 'Camada atual',
                nl: 'Huidige laag',
                fr: 'Couche actuelle',
                it: 'Livello attuale',
                es: 'Capa actual',
                pl: 'Aktualna warstwa',
                uk: 'Поточний шар',
                'zh-cn': '当前层',
            },
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: -1,
        },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer.total', {
        type: 'state',
        common: {
            name: {
                en: 'Total Layers',
                de: 'Gesamtebenen',
                ru: 'Всего слоев',
                pt: 'Camadas totais',
                nl: 'Totaal aantal lagen',
                fr: 'Couches totales',
                it: 'Strati totali',
                es: 'Capas totales',
                pl: 'Całkowita liczba warstw',
                uk: 'Всього шарів',
                'zh-cn': '总层数',
            },
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: -1,
        },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer.averageDuration', {
        type: 'state',
        common: {
            name: {
                en: 'Average layer duration',
                de: 'Durchschnittliche Schichtdauer',
                ru: 'Средняя продолжительность слоя',
                pt: 'Duração média da camada',
                nl: 'Gemiddelde laagduur',
                fr: 'Durée moyenne des couches',
                it: 'Durata media del livello',
                es: 'Duración media de la capa',
                pl: 'Średni czas trwania warstwy',
                uk: 'Середня тривалість шару',
                'zh-cn': '平均层持续时间',
            },
            type: 'number',
            role: 'value',
            unit: 's',
            read: true,
            write: false,
            def: 0,
        },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer.lastDuration', {
        type: 'state',
        common: {
            name: {
                en: 'Last layer duration',
                de: 'Dauer der letzten Schicht',
                ru: 'Длительность последнего слоя',
                pt: 'Duração da última camada',
                nl: 'Duur laatste laag',
                fr: 'Durée de la dernière couche',
                it: "Durata dell'ultimo strato",
                es: 'Duración de la última capa',
                pl: 'Czas trwania ostatniej warstwy',
                uk: 'Остання тривалість шару',
                'zh-cn': '最后一层持续时间',
            },
            type: 'number',
            role: 'value',
            unit: 's',
            read: true,
            write: false,
            def: 0,
        },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.feedrate', {
        type: 'state',
        common: {
            name: {
                en: 'Feedrate',
                de: 'Vorschubgeschwindigkeit',
                ru: 'Скорость подачи',
                pt: 'Taxa de alimentação',
                nl: 'Voedingssnelheid',
                fr: "Vitesse d'avance",
                it: 'avanzamento',
                es: 'Velocidad de avance',
                pl: 'Szybkość posuwu',
                uk: 'Корми',
                'zh-cn': '进给率',
            },
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: 0,
        },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.fanSpeed', {
        type: 'state',
        common: {
            name: {
                en: 'Fan speed',
                de: 'Lüftergeschwindigkeit',
                ru: 'Скорость вентилятора',
                pt: 'Velocidade do ventilador',
                nl: 'Ventilator snelheid',
                fr: 'Vitesse du ventilateur',
                it: 'Velocità della ventola',
                es: 'Velocidad del ventilador',
                pl: 'Prędkość wiatraka',
                uk: 'Швидкість вентилятора',
                'zh-cn': '风扇转速',
            },
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            unit: '%',
            def: 0,
        },
        native: {},
    });

    adapter
        .buildPluginRequest('DisplayLayerProgress/values')
        .then(response => {
            if (response.status === 200) {
                if (response.data.layer.current !== '-') {
                    adapter.setStateAsync('plugins.displayLayerProgress.layer.current', {
                        val: parseInt(response.data.layer.current),
                        ack: true,
                    });
                }

                if (response.data.layer.total !== '-') {
                    adapter.setStateAsync('plugins.displayLayerProgress.layer.total', {
                        val: parseInt(response.data.layer.total),
                        ack: true,
                    });
                }

                if (response.data.layer.averageLayerDurationInSeconds !== '-') {
                    adapter.setStateAsync('plugins.displayLayerProgress.layer.averageDuration', {
                        val: parseInt(response.data.layer.averageLayerDurationInSeconds),
                        ack: true,
                    });
                }

                if (response.data.layer.lastLayerDurationInSeconds !== '-') {
                    adapter.setStateAsync('plugins.displayLayerProgress.layer.lastDuration', {
                        val: parseInt(response.data.layer.lastLayerDurationInSeconds),
                        ack: true,
                    });
                }

                if (response.data.feedrate !== '-') {
                    adapter.setStateAsync('plugins.displayLayerProgress.feedrate', {
                        val: parseInt(response.data.feedrate.replace(/[^\d.]/g, '')),
                        ack: true,
                    });
                }

                if (response.data.fanSpeed !== '-') {
                    adapter.setStateAsync('plugins.displayLayerProgress.fanSpeed', {
                        val: parseInt(response.data.fanSpeed.replace(/[^\d.]/g, '')),
                        ack: true,
                    });
                }
            } else {
                adapter.log.error(
                    `[plugin display layer progress] status ${response.status}: ${JSON.stringify(response.data)}`,
                );
            }
        })
        .catch(error => {
            adapter.log.debug(`[plugin display layer progress] error ${error}`);
        });
}

module.exports = {
    refreshValues: refreshValues,
};
