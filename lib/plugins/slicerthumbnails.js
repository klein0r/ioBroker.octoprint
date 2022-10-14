'use strict';

const axios = require('axios').default;

async function downloadThumbnailsToStates(adapter) {
    const fileChannels = await adapter.getChannelsOfAsync('files');

    // Collect all existing files
    if (fileChannels) {
        for (let i = 0; i < fileChannels.length; i++) {
            const idNoNamespace = adapter.removeNamespace(fileChannels[i]._id);

            // Check if the state is a direct child (e.g. files.MyCustomFile)
            if (idNoNamespace.split('.').length === 2) {
                const urlState = await adapter.getStateAsync(`${idNoNamespace}.thumbnail.url`);

                if (urlState && urlState.val) {
                    const thumbnailId = `${idNoNamespace}.thumbnail.png`;
                    const thumbnailUrl = urlState.val;

                    try {
                        await adapter.getForeignBinaryStateAsync(`${adapter.namespace}.${thumbnailId}`);

                        adapter.log.debug(`[refreshFiles] [plugin slicer thumbnails] skipping download for ${thumbnailId} from ${thumbnailUrl} - already exists`);
                    } catch (err) {
                        if (err == 'Error: State is not binary') {
                            adapter.log.debug(`[refreshFiles] [plugin slicer thumbnails] starting download for ${thumbnailId} from ${thumbnailUrl}`);

                            await downloadThumbnailFor(adapter, thumbnailUrl, thumbnailId);
                        }
                    }
                }
            }
        }
    }
}

async function downloadThumbnailFor(adapter, thumbnailUrl, thumbnailId) {
    try {
        const response = await axios.get(thumbnailUrl, {
            responseType: 'arraybuffer',
            timeout: adapter.config.apiTimeoutSek * 1000,
            validateStatus: (status) => {
                return [200].indexOf(status) > -1;
            },
        });

        if (response.data) {
            const responseType = Object.prototype.toString.call(response.data);
            adapter.log.debug(`[refreshFiles] [plugin slicer thumbnails] received data as ${responseType} for ${thumbnailUrl}: ${JSON.stringify(response.headers)}`);

            adapter.setForeignBinaryState(`${adapter.namespace}.${thumbnailId}`, Buffer.from(response.data), () => {
                adapter.log.debug(`[refreshFiles] [plugin slicer thumbnails] saved binary information in ${thumbnailId}`);
            });
        } else {
            adapter.log.debug(`[refreshFiles] [plugin slicer thumbnails] response was empty: ${JSON.stringify(response.headers)}`);
        }
    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code

            adapter.log.warn(`[refreshFiles] [plugin slicer thumbnails] received ${error.response.status} response from ${thumbnailUrl}`);
        } else if (error.request) {
            // The request was made but no response was received
            // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
            // http.ClientRequest in node.js

            adapter.log.info(`[refreshFiles] [plugin slicer thumbnails] error ${error.code} from ${thumbnailUrl}: ${error.message}`);
        } else {
            // Something happened in setting up the request that triggered an Error
            adapter.log.error(error.message);
        }
    }
}

module.exports = {
    downloadThumbnailsToStates: downloadThumbnailsToStates,
};
