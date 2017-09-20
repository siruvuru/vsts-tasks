var path = require('path')
var url = require('url')

import * as tl from 'vsts-task-lib/task';
import { IBuildApi } from 'vso-node-api/BuildApi';
import { IRequestHandler } from 'vso-node-api/interfaces/common/VsoBaseInterfaces';
import { WebApi, getHandlerFromToken } from 'vso-node-api/WebApi';

import * as models from 'item-level-downloader/Models';
import * as engine from 'item-level-downloader/Engine';
import * as providers from 'item-level-downloader/Providers';
import * as webHandlers from 'item-level-downloader/Providers/Handlers';

tl.setResourcePath(path.join(__dirname, 'task.json'));

async function main(): Promise<void> {
    var promise = new Promise<void>(async (resolve, reject) => {
        var buildType: string = tl.getInput("buildType", true);
        var isCurrentBuild : boolean = buildType.toLowerCase() === 'current';
        var projectId : string =  isCurrentBuild ? tl.getVariable("System.TeamProjectId") : tl.getInput("project", true);
        var definitionId : string = isCurrentBuild ? '' : tl.getInput("definition", true);
        var buildId : number = parseInt(isCurrentBuild ? tl.getVariable("Build.BuildId") : tl.getInput("buildId", true));
        var downloadPath : string = tl.getInput("downloadPath", true);
        var downloadType : string = tl.getInput("downloadType", true);

        var endpointUrl : string = tl.getVariable("System.TeamFoundationCollectionUri");
        var accessToken : string = tl.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'AccessToken', false);
        var credentialHandler : IRequestHandler = getHandlerFromToken(accessToken);
        var webApi: WebApi = new WebApi(endpointUrl, credentialHandler);
        var debugMode : string = tl.getVariable('System.Debug');
        var isVerbose : boolean = debugMode ? debugMode.toLowerCase() != 'false' : false;
        var parallelLimit : number = +tl.getVariable("release.artifact.download.parallellimit");

        var templatePath: string = path.join(__dirname, 'vsts.handlebars.txt');
        var buildApi : IBuildApi = webApi.getBuildApi();
        var artifacts = [];
        var itemPattern : string = '**';

        // verfiy that buildId belongs to the definition selected
        if (definitionId) {
            var builds = await buildApi.getBuilds(projectId, [parseInt(definitionId)]).catch((reason) => {
                reject(reason);
            });

            if (builds) {
                var buildIds = builds.map((value, index) => {
                    return value.id;
                });

                if (buildIds.indexOf(buildId) == -1) {
                    reject(tl.loc("BuildIdBuildDefinitionMismatch", buildId, definitionId));
                }
            }
            else {
                reject(tl.loc("NoBuildsFound", definitionId));
            }
        }

        // populate itempattern and artifacts based on downloadType
        if (downloadType === 'single') {
            var artifactName = tl.getInput("artifactName");
            var artifact = await buildApi.getArtifact(buildId, artifactName, projectId).catch((reason) => {
                reject(reason);
            });
            artifacts.push(artifact);
            itemPattern = artifactName + '/**';
        }
        else {
            var buildArtifacts = await buildApi.getArtifacts(buildId, projectId).catch((reason) => {
                reject(reason);
            });

            console.log(tl.loc("LinkedArtifactCount", buildArtifacts.length));
            artifacts = artifacts.concat(buildArtifacts);
            itemPattern = tl.getInput("itemPattern", false) || '**';
        }

        var downloadPromises: Array<Promise<any>> = [];

        artifacts.forEach(async function (artifact, index, artifacts) {
            let downloaderOptions = new engine.ArtifactEngineOptions();
            downloaderOptions.itemPattern = itemPattern;
            downloaderOptions.verbose = isVerbose;

            if(parallelLimit){
                downloaderOptions.parallelProcessingLimit = parallelLimit;
            }

            if (artifact.resource.type.toLowerCase() === "container") {
                let downloader = new engine.ArtifactEngine();
                var containerParts: string[] = artifact.resource.data.split('/', 3);
                if (containerParts.length !== 3) {
                    throw new Error(tl.loc("FileContainerInvalidArtifactData"));
                }

                var containerId: number = parseInt(containerParts[1]);
                var containerPath: string = containerParts[2];

                var itemsUrl = endpointUrl + "/_apis/resources/Containers/" + containerId + "?itemPath=" + containerPath + "&isShallow=true";
                console.log(tl.loc("DownloadArtifacts", itemsUrl));

                var variables = {};
                var handler = new webHandlers.PersonalAccessTokenCredentialHandler(accessToken);
                var webProvider = new providers.WebProvider(itemsUrl, templatePath, variables, handler);
                var fileSystemProvider = new providers.FilesystemProvider(downloadPath);

                downloadPromises.push(downloader.processItems(webProvider, fileSystemProvider, downloaderOptions).catch((reason) => {
                    reject(reason);
                }));
            }
            else if (artifact.resource.type.toLowerCase() === "filepath") {
                let downloader = new engine.ArtifactEngine();
                console.log(tl.loc("DownloadArtifacts", artifact.resource.downloadUrl));
                var fileShareProvider = new providers.FilesystemProvider(artifact.resource.downloadUrl.replace("file:", ""));
                var fileSystemProvider = new providers.FilesystemProvider(downloadPath);

                downloadPromises.push(downloader.processItems(fileShareProvider, fileSystemProvider, downloaderOptions).catch((reason) => {
                    reject(reason);
                }));
            }
            else {
                tl.warning(tl.loc("UnsupportedArtifactType", artifact.resource.type));
            }
        });

        Promise.all(downloadPromises).then(() => {
            console.log(tl.loc('ArtifactsSuccessfullyDownloaded', downloadPath));
            resolve();
        }).catch((error) => {
            reject(error);
        });
    });

    return promise;
}

main()
    .then((result) => tl.setResult(tl.TaskResult.Succeeded, ""))
    .catch((error) => tl.setResult(tl.TaskResult.Failed, error));