let apiUrl = 'https://api.ellipsis-drive.com/v2';
let deprecatedApiUrl = 'https://api.ellipsis-drive.com/v1';

function ApiError(status, message) {
    const error = Error.call(this, message);

    this.name = 'API Error';
    this.message = error.message;
    this.stack = error.stack;
    this.status = status;
}

function toUrlParams(jsonParams, noPrefix = false) {
    Object.entries(jsonParams).forEach(([key, val]) => {
        if (typeof val === 'object') //arrays are also objects in js
            jsonParams[key] = JSON.stringify(val)
        if (val == undefined)
            delete jsonParams[key];
    });
    const params = new URLSearchParams(jsonParams).toString();
    if (noPrefix) return params;
    return (params === "" ? "" : ("?" + params));
}

async function ellipsisApiManagerFetch(method, route, body, user, _apiUrl) {
    let headers = {};

    headers['Content-Type'] = 'application/json';
    if (user)
        headers['Authorization'] = `Bearer ${user.token}`;

    const useUrlParams = method === "HEAD" || method === "GET" || method === "DELETE";
    const urlParamsJson = useUrlParams ? { mapId: user?.mapId, ...body } : { mapId: user?.mapId }
    const urlAddition = toUrlParams(urlParamsJson);

    const url = `${_apiUrl ?? apiUrl}${route}${urlAddition}`;
    let gottenResponse = null;
    let isText = false;
    let isJson = false;

    let options = {
        method: method,
        headers: headers,
    };

    if (body && !useUrlParams) {
        options.body = JSON.stringify(body);
    }

    return await fetch(url, options)
        .then((response) => {
            if (!response.ok) {
                if (response.status === 429) {
                    alert(
                        `You made too many calls to this map and won't be able to use it for another minute. Contact the owner of this map to give you more bandwidth.`
                    );
                }
            }

            gottenResponse = response;

            let contentType = response.headers.get('Content-Type');

            if (contentType) {
                isText = contentType.includes('text');
                isJson = contentType.includes('application/json');
            } else {
                isText = true;
            }

            if (isJson) {
                return response.json();
            } else if (isText) {
                return response.text();
            } else {
                return response.blob();
            }
        })
        .then((result) => {
            if (gottenResponse.status === 200) {
                return result;
            } else {
                if (!isText) {
                    throw new ApiError(gottenResponse.status, result.message);
                } else {
                    throw new ApiError(gottenResponse.status, result);
                }
            }
        });
}

export { toUrlParams }

export default {

    setApiUrl: (newUrl) => apiUrl = newUrl,
    /**
     * @deprecated Please use getApiUrl() instead.
     */
    apiUrl: apiUrl,
    /**
     * Get the url of the api.
     * @returns {string}
     */
    getApiUrl: () => apiUrl,

    /**
     * Send a post request to the ellipsis api.
     * @param {string} url 
     * @param {object} body 
     * @param {{token: string}} user 
     * @returns 
     */
    post: (url, body, user) => {
        return ellipsisApiManagerFetch('POST', url, body, user);
    },

    get: (url, body, user) => {
        return ellipsisApiManagerFetch('GET', url, body, user);
    },

    /**
     * Login into an ellipsis drive account with a username and password
     * @param {string} username 
     * @param {string} password 
     * @returns 
     */
    login: (username, password) => {
        return ellipsisApiManagerFetch('POST', '/account/login', { username, password });
    },


    /**
     * Get metadata of path with pathId
     * @param {string} pathId 
     * @param {{token: string}}} user 
     */
    getPath: (pathId, user) => {
        return ellipsisApiManagerFetch('GET', `/path/${pathId}`, undefined, user);
    },

    /**
     * @deprecated Get metadata for something stored in your drive.
     * @param {string} pathId the id of something stored in your drive like a block, shape or folder
     * @param {{token: string}} user 
     * @returns metadata of the given map/shape/folder
     */
    getInfo: (pathId, user) => {
        return getPath(pathId, user)
    },


    /**
     * @deprecated The metadata request was ported to an info request. So please use getInfo() instead.
     * @param {string} blockId 
     * @param {boolean} includeDeleted 
     * @param {{token: string}} user 
     * @returns 
     */
    getMetadata: (blockId, includeDeleted, user) => {
        let body;
        if (includeDeleted) body = { mapId: blockId, includeDeleted };
        else body = { mapId: blockId };

        return ellipsisApiManagerFetch('POST', '/metadata', body, user, deprecatedApiUrl);
    },

}