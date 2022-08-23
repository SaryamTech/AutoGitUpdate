
# Auto Git Update
a node.js module used for automatically updating projects from a git repository. 
<br><br>

### Notes
 - To update from private repositories a personal access token needs to be provided. 
 - During updates a backup of the old version is taken and stored in the configured tempLocation. If update process fails then old backup is put back to source
 - The remote package.json is compared to the local package.json to determine if a different version is available. 
 - Use winston logger for clear concise logging
 - EventEmitter provides various events through out the update cycle.
 - Allow update of 3rd party apps.

<br><br>

### Config Options
 - **repository** *String* - The url to the root of a git repository to update from.
 - **tempLocation** *String* - The local dir to save temporary information for Auto Git Update.
 - **fromReleases** *Boolean* - [optional] Updated based off of latest published GitHub release instead of branch package.json.
 - **branch** *String* - [optional] The branch to update from. Defaults to master.
 - **token** *String* - [optional] A personal access token used for accessions private repositories. 
 - **ignoreFiles** *Array[String]* - [optional] An array of files to not install when updating. Useful for config files. 
 - **autoUpdateOnCheck** *Boolean* - [optional] Force update if version mismatch found or manual update process.
 - **executeOnComplete** *String* - [optional] A command to execute after an update completes. Good for restarting the app.
 - **exitOnComplete** *Boolean* - [optional] Use process exit to stop the app after a successful update.
<br><br>

### Functions
 - **autoUpdate()** - Updates if local package.json version is different than remote.
 - **compareVersions()** - Compares package.json versions without updating.
   - Returns an object with the properties *upToDate*, *currentVersion*, & *remoteVersion*.
 - **forceUpdate()** - Updates without comparing package versions.
<br><br>

### Example
```
```
```
const AutoGitUpdate = require('auto-git-update');

const config = {
    repository: 'https://github.com/chegele/BackupPurger',
    fromReleases: true,
    tempLocation: 'C:/Users/scheg/Desktop/tmp/',
    ignoreFiles: ['util/config.js'],
    executeOnComplete: 'C:/Users/scheg/Desktop/worksapce/AutoGitUpdate/startTest.bat',
    exitOnComplete: true
}

const updater = new AutoGitUpdate(config);

updater.autoUpdate();
```


### Events
 - **version-ok** - This event is emitted when there is no mismatch in and the local and remote versions.
 - **version-mismatch** - This event is emitted when there is a mismatch in the local and remote versions.
 - **update-success** - This event is emitted when the update process has completed successfully.
 - **update-failure** - This event is emitted when there is an error in the update process.
 - **backup-start** - This event is emitted when the backup process starts.
 - **backup-end** - This event is emitted when the backup process has completed.
 - **reload-start** - This event is emitted when the reload process starts.
 - **reload-end** -  This event is emitted when the reload process ends.
 - **reload-error** - This event is emitted when there is an error in the reload process.
 - **download-start** - This event is emitted when the download process starts.
 - **download-end** - This event is emitted when the download process ends.
 - **install-deps-start** - This event is emitted when the dependency installation process starts.
 - **install-deps-end** - This event is emitted when the dependency installation process ends.
 - **install-deps-error** - This event is emitted when there is an error in the dependency installation process.
 - **install-update-start** - This event is emitted when the update installation process starts.
 - **install-update-end** - This event is emitted when the update installation process ends.
<br><br>