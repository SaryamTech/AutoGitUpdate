
const path = require('path');
const fs = require('fs-extra');
const { spawn, exec } = require('child_process');
const https = require('https');
const appRootPath = require('app-root-path');
const git = require('simple-git');
const winston = require('winston');
const { EventEmitter } = require('stream');

/** 
 * @typedef {Object} Config - Configuration for Auto Git Update
 * @property {String} repository - The url to the root of a git repository to update from, or /latest GitHub release. 
 * @property {String} branch - The branch to update from. Defaults to master.
 * @property {Boolean} fromReleases - Updated based off of latest published GitHub release instead of branch package.json.
 * @property {String} token - A personal access token used for accessions private repositories.
 * @property {String} tempLocation - The local dir to save temporary information for Auto Git Update.
 * @property {Boolean} autoUpdateOnCheck - Force update if version mismatch found or manual update process.
 * @property {Array[String]} ignoreFiles - An array of files to not install when updating. Useful for config files. 
 * @property {String} executeOnComplete - A command to execute after an update completes. Good for restarting the app.
 * @property {Boolean} exitOnComplete - Use process exit to stop the app after a successful update.
 */

/** @type {Config} */
let config = {}

// Subdirectories to use within the configured tempLocation from above. 
const cloneSubdirectory = '/AutoGitUpdate/repo/';
const backupSubdirectory = '/AutoGitUpdate/backup/';

// Enable during testing to prevent overwrite of Auto Git Update
const testing = false;

// Create winston logger
const logger = winston.createLogger({
    format: winston.format.json(),
    defaultMeta: { service: 'user-service' },
    transports: [
        new winston.transports.File({ filename: '/home/saryam/Saryam/logs/BLELogs/BLEAutoUpdateError.log', level: 'error' }),
        new winston.transports.File({ filename: '/home/saryam/Saryam/logs/BLELogs/BLEAutoUpdate.log' }),
    ],
});

//Console
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple(),
    }));
}


// Toggles if performing async setup task
let ready = true;

// Toggles if Backup of app is complete
let backupOK = false;

// AppPath -> Default running application's root path
let autoUpdateAppPath = appRootPath.path;

module.exports = class AutoGitUpdate extends EventEmitter {
    /**
     * Creates an object which can be used to automatically update an application from a remote git repository. 
     * @param {Config} updateConfig 
     */
    constructor(updateConfig) {

        //Super class constructor
        super();

        // validate config has required properties
        if (updateConfig == undefined) throw new Error('You must pass a config object to AutoGitUpdate.');
        if (updateConfig.repository == undefined) throw new Error('You must include a repository link.');
        if (updateConfig.branch == undefined) updateConfig.branch = 'master';
        if (updateConfig.tempLocation == undefined) throw new Error('You must define a temp location for cloning the repository');

        //Set auto update app's path (Current app or another app)
        autoUpdateAppPath = updateConfig.appPathLocation ? updateConfig.appPathLocation : appRootPath.path;

        // Update config and retrieve current tag if configured to use releases
        config = updateConfig;
        if (config.fromReleases) {
            ready = false;
            setBranchToReleaseTag(config.repository);
        }

        // Validate that Auto Git Update is being used as a dependency or testing is enabled
        // This is to prevent the Auto Git Update module from being overwritten on accident during development
        if (!testing) {
            let file = path.join(autoUpdateAppPath, 'package.json');
            let appPackage = fs.readFileSync(file);
            appPackage = JSON.parse(appPackage);
            if (appPackage.name == 'auto-git-update') throw new Error('Auto Git Update is not being ran as a dependency & testing is not enabled.');
        }

    }

    /**
     * Checks local version against the remote version & then updates if different. 
     */
    async autoUpdate() {
        while (!ready) { await sleep(1000); logger.info('Auto Git Update - Not ready to update...') };

        let versionCheck = await this.compareVersions();
        if (versionCheck.upToDate) {

            //Emit Version OK
            this.emit("version-ok", versionCheck);

            return true;
        };

        //Emit Version mismatch
        this.emit("version-mismatch", versionCheck);

        //Check autoUpdateOnCheck
        if (config.autoUpdateOnCheck ? config.autoUpdateOnCheck : false) {
            return await this.forceUpdate();
        }

        return false;
    }

    /**
     * @typedef VersionResults
     * @param {Boolean} UpToDate - If the local version is the same as the remote version.
     * @param {String} currentVersion - The version of the local application.
     * @param {String} remoteVersion - The version of the application in the git repository. 
     * 
     * Checks the local version of the application against the remote repository.
     * @returns {VersionResults} - An object with the results of the version comparison.
     */
    async compareVersions() {
        try {

            logger.info('Auto Git Update - Comparing versions...');

            let currentVersion = readAppVersion();
            let remoteVersion = await readRemoteVersion();

            logger.info('Auto Git Update - Current version: ' + currentVersion);
            logger.info('Auto Git Update - Remote Version: ' + remoteVersion);

            if (currentVersion == remoteVersion) return { upToDate: true, currentVersion };
            return { upToDate: false, currentVersion, remoteVersion };

        } catch (err) {

            logger.error('Auto Git Update - Error comparing local and remote versions.');
            logger.error(err);

            return { upToDate: false, currentVersion: 'Error', remoteVersion: 'Error' }
        }
    }

    /**
     * Clones the git repository, purges ignored files, and installs the update over the local application.
     * A backup of the application is created before the update is installed.
     * If configured, a completion command will be executed and the process for the app will be stopped. 
     * @returns {Boolean} The result of the update.
     */
    async forceUpdate() {
        try {

            logger.info('Auto Git Update - Updating application from ' + config.repository);

            //Download update
            await downloadUpdate();

            //Backup current app
            await backupApp();

            //Install update
            await installUpdate();

            //Install Dependencies
            await installDependencies();

            logger.info('Auto Git Update - Finished installing updated version.');

            //Emit update success
            this.emit("update-success");

            //Auto restart functionality
            if (config.executeOnComplete) await promiseBlindExecute(config.executeOnComplete);
            if (config.exitOnComplete) process.exit(1);

            return true;

        } catch (err) {

            logger.error('Auto Git Update - Error updating application');
            logger.error(err);

            //Emit update success
            this.emit("update-failure");

            //Check backupOK
            if (backupOK) {

                //Reload backup to source
                await reloadBackup();
            }

            return false;
        }
    }

}

////////////////////////////
// AUTO GIT UPDATE FUNCTIONS 

/**
 * Creates a backup of the application, including node modules. 
 * The backup is stored in the configured tempLocation. Only one backup is kept at a time. 
 */
async function backupApp() {

    //Emit backup-start
    this.emit("backup-start");

    let destination = path.join(config.tempLocation, backupSubdirectory);
    logger.info('Auto Git Update - Backing up app to ' + destination);

    //Confirm and empty directory
    await fs.ensureDir(destination);
    await fs.emptyDir(destination);

    //Copy app files to temp directory
    await fs.copy(autoUpdateAppPath, destination, { dereference: true });

    //Emit backup-end
    this.emit("backup-end");

    //Set backupOK flag
    backupOK = true;

    return true;
}


/**
 * Reloads the backup
 */
async function reloadBackup() {

    try {

        //Emit reload-start
        this.emit("reload-start");

        let source = path.join(config.tempLocation, backupSubdirectory);
        logger.info('Auto Git Update - Reloading app from ' + source);

        //Confirm directory
        await fs.ensureFile(path.join(source, "package.json"));

        //Reload backup files to app directory
        await fs.copy(source, autoUpdateAppPath, { dereference: true });

        //Emit reload-end
        this.emit("reload-end");

        return true;

    }
    catch (err) {

        logger.error('Auto Git Update - Error reloading backup files.');
        logger.error(err);

        //Emit reload-error
        this.emit("reload-error", err);

        return false;

    }
}


/**
 * Downloads the update from the configured git repository.
 * The repo is cloned to the configured tempLocation. 
 */
async function downloadUpdate() {

    // Inject token for private repositories 
    let repo = config.repository;
    if (config.token) {
        repo = repo.replace('http://', '').replace('https://', '');
        repo = `https://${config.token}@${repo}`;
    }

    // Empty destination directory & clone repo
    let destination = path.join(config.tempLocation, cloneSubdirectory);
    logger.info('Auto Git Update - Cloning ' + repo);
    logger.info('Auto Git Update - Destination: ' + destination);
    await fs.ensureDir(destination);
    await fs.emptyDir(destination);

    //Emit download-start
    this.emit("download-start");

    await promiseClone(repo, destination, config.branch);

    //Emit download-start
    this.emit("download-end");

    return true;
}

/**
 * Runs npm install to update/install application dependencies.
 */
function installDependencies() {
    return new Promise(function (resolve, reject) {

        //Emit install-deps-start
        this.emit("install-deps-start");

        //If testing is enabled, use alternative path to prevent overwrite of app. 
        let destination = testing ? path.join(autoUpdateAppPath, '/testing/') : autoUpdateAppPath;
        logger.info('Auto Git Update - Installing application dependencies in ' + destination);

        // Generate and execute command
        let command = `cd ${destination} && npm install`;
        let child = exec(command);

        // Wait for results
        child.stdout.on('end', function () {

            //Emit install-deps-end
            this.emit("install-deps-end");

            //resolve promise
            resolve();

        });
        child.stdout.on('data', data => logger.info('Auto Git Update - npm install: ' + data.replace(/\r?\n|\r/g, '')));
        child.stderr.on('data', data => {
            if (data.toLowerCase().includes('error')) {

                // npm passes warnings as errors, only reject if "error" is included
                data = data.replace(/\r?\n|\r/g, '');
                logger.error('Auto Git Update - Error installing dependencies');
                logger.error('Auto Git Update - ' + data);

                //Emit install-deps-error
                this.emit("install-deps-error");

                reject();

            } else {
                logger.warn('Auto Git Update - ' + data);
            }
        });
    });
}

/**
 * Purge ignored files from the update, copy the files to the app directory, and install new modules
 * The update is installed from  the configured tempLocation.
 */
async function installUpdate() {

    //Emit install-update-start
    this.emit("install-update-start");

    // Remove ignored files from the new version
    if (config.ignoreFiles) {
        logger.info('Auto Git Update - Purging ignored files from the update');
        config.ignoreFiles.forEach(file => {
            file = path.join(config.tempLocation, cloneSubdirectory, file);
            logger.info('Auto Git Update - Removing ' + file);
            fs.unlinkSync(file);
        });
    }

    // Install updated files
    let source = path.join(config.tempLocation, cloneSubdirectory);
    //If testing is enabled, use alternative path to prevent overwrite of app. 
    let destination = testing ? path.join(autoUpdateAppPath, '/testing/') : autoUpdateAppPath;
    
    logger.info('Auto Git Update - Installing update...');
    logger.info('Auto Git Update - Source: ' + source);
    logger.info('Auto Git Update - Destination: ' + destination);
    
    await fs.ensureDir(destination);
    await fs.emptyDir(destination);
    await fs.copy(source, destination);

    //Emit install-update-end
    this.emit("install-update-end");
    
    return true;
}

/**
 * Reads the applications version from the package.json file.
 */
function readAppVersion() {
    let file = path.join(autoUpdateAppPath, 'package.json');
    logger.info('Auto Git Update - Reading app version from ' + file);
    let appPackage = fs.readFileSync(file);
    return JSON.parse(appPackage).version;
}

/**
 * Reads the applications version from the git repository.
 */
async function readRemoteVersion() {
    
    // Generate request details
    let options = {}
    let url = config.repository + `/${config.branch}/package.json`;
    if (url.includes('github')) url = url.replace('github.com', 'raw.githubusercontent.com');
    if (config.token) options.headers = { Authorization: `token ${config.token}` }
    logger.info('Auto Git Update - Reading remote version from ' + url);
    
    // Send request for repositories raw package.json file
    try {
        let body = await promiseHttpsRequest(url, options);
        let remotePackage = JSON.parse(body);
        let version = remotePackage.version;
        return version;
    } catch (err) {
        if (err = 404) throw new Error('This repository requires a token or does not exist. \n ' + url);
        throw err;
    }
}


/**
 * Updates the configuration for this updater to use the latest release as the repo branch
 * @param {String} repository - The link to the repo 
 */
async function setBranchToReleaseTag(repository) {
    
    // Validate the configuration & generate request details
    let options = { headers: { "User-Agent": "Auto-Git-Update - " + repository } }
    if (config.token) options.headers.Authorization = `token ${config.token}`;
    repository = repository.toLocaleLowerCase().replace('github.com/', 'api.github.com/repos/');
    if (!repository.includes('github')) throw new Error('fromReleases is enabled but this does not seem to be a GitHub repo.');
    if (repository.endsWith('/')) repository = repository.slice(0, -1);
    const url = (repository + '/releases/latest')
    logger.info('Auto Git Update - Checking release tag from ' + url);

    // Attempt to identify the tag/version of the latest release
    try {
        let body = await promiseHttpsRequest(url, options);
        let response = JSON.parse(body);
        let tag = response.tag_name;
        config.branch = tag;
        ready = true;
    } catch (err) {
        if (err = 404) throw new Error('This repository requires a token or does not exist. \n ' + url);
        throw err;
    }
}


////////////////////////////
// HELPER & MISC FUNCTIONS 

/**
 * A promise wrapper for the simple-git clone function
 * @param {String} repo - The url of the repository to clone.
 * @param {String} destination - The local path to clone into.
 * @param {String} branch - The repo branch to clone. 
 */
function promiseClone(repo, destination, branch) {
    return new Promise(function (resolve, reject) {
        git().clone(repo, destination, [`--branch=${branch}`], result => {
            if (result != null) reject(`Unable to clone repo \n ${repo} \n ${result}`);
            resolve();
        });
    });
}

/**
 * A promise wrapper for the child-process spawn function. Does not listen for results.
 * @param {String} command - The command to execute. 
 */
function promiseBlindExecute(command) {
    return new Promise(function (resolve, reject) {
        spawn(command, [], { shell: true, detached: true });
        setTimeout(resolve, 1000);
    });
}

/**
 * A promise wrapper for sending a get https requests.
 * @param {String} url - The Https address to request.
 * @param {String} options - The request options. 
 */
function promiseHttpsRequest(url, options) {
    return new Promise(function (resolve, reject) {
        let req = https.request(url, options, res => {
            //Construct response
            let body = '';
            res.on('data', data => { body += data });
            res.on('end', function () {
                if (res.statusCode == '200') return resolve(body);
                logger.info('Auto Git Update - Bad Response ' + res.statusCode);
                reject(res.statusCode);
            });
        });
        logger.info('Auto Git Update - Sending request to ' + url);
        logger.info('Auto Git Update - Options: ' + JSON.stringify(options));
        req.on('error', reject);
        req.end();
    });
}

async function sleep(time) {
    return new Promise(function (resolve, reject) {
        setTimeout(resolve, time);
    });
}
