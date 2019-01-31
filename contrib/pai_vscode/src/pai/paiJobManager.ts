/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */

import * as fs from 'fs-extra';
import * as globby from 'globby';
import { injectable } from 'inversify';
import * as JSONC from 'jsonc-parser';
import { isEmpty } from 'lodash';
import * as os from 'os';
import * as path from 'path';
import * as querystring from 'querystring';
import * as request from 'request-promise-native';
import * as uuid from 'uuid';
import * as vscode from 'vscode';

import {
    COMMAND_CREATE_JOB_CONFIG, COMMAND_SIMULATE_JOB, COMMAND_SUBMIT_JOB,
    OCTICON_CLOUDUPLOAD,
    SCHEMA_JOB_CONFIG,
    SETTING_JOB_GENERATEJOBNAME_ENABLED,
    SETTING_JOB_UPLOAD_ENABLED, SETTING_JOB_UPLOAD_EXCLUDE, SETTING_JOB_UPLOAD_INCLUDE,
    SETTING_SECTION_JOB
} from '../common/constants';
import { __ } from '../common/i18n';
import { getSingleton, Singleton } from '../common/singleton';
import { Util } from '../common/util';
import { ClusterManager, getClusterIdentifier, getClusterWebPortalUri } from './clusterManager';
import { ConfigurationNode } from './configurationTreeDataProvider';
import { getHDFSUriAuthority, HDFS, HDFSFileSystemProvider } from './hdfs';
import { IPAICluster, IPAIJobConfig, IPAITaskRole } from './paiInterface';

import opn = require('opn'); // tslint:disable-line
import unixify = require('unixify'); // tslint:disable-line
interface ITokenItem {
    token: string;
    expireTime: number;
}

interface IJobParam {
    config: IPAIJobConfig;
    cluster?: IPAICluster;
    workspace: string;
    upload?: {
        exclude: string[];
        include: string[];
    };
    generateJobName: boolean;
}

interface IJobInput {
    jobConfigPath?: string;
    clusterIndex?: number;
}

/**
 * Manager class for PAI job submission
 */
@injectable()
export class PAIJobManager extends Singleton {
    private static readonly API_PREFIX: string = 'api/v1';
    private static readonly TIMEOUT: number = 60 * 1000;
    private static readonly SIMULATION_DOCKERFILE_FOLDER: string = '.pai_simulator';
    private static readonly propertiesToBeReplaced: (keyof IPAIJobConfig)[] = [
        'codeDir',
        'outputDir',
        'dataDir',
        'authFile'
    ];
    private static readonly envNeedClusterInfo: string[] = [
        'PAI_USER_NAME',
        'PAI_CODE_DIR',
        'PAI_OUTPUT_DIR',
        'PAI_DATA_DIR',
        'PAI_DEFAULT_FS_URI'
    ];
    private cachedTokens: Map<string, ITokenItem> = new Map();
    private simulateTerminal: vscode.Terminal | undefined;

    constructor() {
        super();
        this.context.subscriptions.push(
            vscode.commands.registerCommand(
                COMMAND_CREATE_JOB_CONFIG,
                async (input?: ConfigurationNode | vscode.Uri) => {
                    if (input instanceof vscode.Uri) {
                        await PAIJobManager.generateJobConfig(input.fsPath);
                    } else {
                        await PAIJobManager.generateJobConfig();
                    }
                }
            ),
            vscode.commands.registerCommand(
                COMMAND_SIMULATE_JOB,
                async (input?: ConfigurationNode | vscode.Uri) => {
                    if (input instanceof vscode.Uri) {
                        await this.simulate({ jobConfigPath: input.fsPath });
                    } else if (input instanceof ConfigurationNode) {
                        await this.simulate({ clusterIndex: input.index });
                    } else {
                        await this.simulate();
                    }
                }
            ),
            vscode.commands.registerCommand(
                COMMAND_SUBMIT_JOB,
                async (input?: ConfigurationNode | vscode.Uri) => {
                    if (input instanceof vscode.Uri) {
                        await this.submitJob({ jobConfigPath: input.fsPath });
                    } else if (input instanceof ConfigurationNode) {
                        await this.submitJob({ clusterIndex: input.index });
                    } else {
                        await this.submitJob();
                    }
                }
            )
        );
    }

    public static async generateJobConfig(script?: string): Promise<void> {
        let defaultSaveDir: string;
        let config: IPAIJobConfig | undefined;
        if (!script) {
            const folders: vscode.WorkspaceFolder[] | undefined = vscode.workspace.workspaceFolders;
            let parent: string = os.homedir();
            const name: string = 'new_job';
            if (!isEmpty(folders)) {
                const fileFolders: vscode.WorkspaceFolder[] = folders!.filter(x => x.uri.scheme === 'file');
                if (!isEmpty(fileFolders)) {
                    parent = fileFolders[0].uri.fsPath;
                }
            }
            defaultSaveDir = path.join(parent, `${name}.pai.json`);
            config = {
                jobName: '<job name>',
                image: 'aiplatform/pai.build.base',
                codeDir: '$PAI_DEFAULT_FS_URI/$PAI_USER_NAME/$PAI_JOB_NAME',
                dataDir: '$PAI_DEFAULT_FS_URI/Data/$PAI_JOB_NAME',
                outputDir: '$PAI_DEFAULT_FS_URI/Output/$PAI_JOB_NAME',
                taskRoles: [
                    {
                        name: 'task',
                        taskNumber: 1,
                        cpuNumber: 1,
                        gpuNumber: 0,
                        memoryMB: 1000,
                        command: 'python $PAI_JOB_NAME/<start up script>'
                    }
                ]
            };
        } else {
            const workspace: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(script));
            let parent: string;
            if (workspace === undefined) {
                parent = path.dirname(script);
            } else {
                parent = workspace.uri.fsPath;
            }
            script = path.relative(parent, script);
            const jobName: string = path.basename(script, path.extname(script));
            defaultSaveDir = path.join(parent, `${jobName}.pai.json`);
            config = {
                jobName,
                image: 'aiplatform/pai.build.base',
                codeDir: '$PAI_DEFAULT_FS_URI/$PAI_USER_NAME/$PAI_JOB_NAME',
                dataDir: '$PAI_DEFAULT_FS_URI/Data/$PAI_JOB_NAME',
                outputDir: '$PAI_DEFAULT_FS_URI/Output/$PAI_JOB_NAME',
                taskRoles: [
                    {
                        name: 'task',
                        taskNumber: 1,
                        cpuNumber: 1,
                        gpuNumber: 0,
                        memoryMB: 1000,
                        command: `python $PAI_JOB_NAME/${unixify(script)}`
                    }
                ]
            };
        }

        const saveDir: vscode.Uri | undefined = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultSaveDir)
        });
        if (saveDir) {
            await fs.writeJSON(saveDir.fsPath, config, { spaces: 4 });
            await vscode.window.showTextDocument(saveDir);
        }
    }

    private static async ensureSettings(): Promise<vscode.WorkspaceConfiguration> {
        const settings: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(SETTING_SECTION_JOB);
        if (settings.get(SETTING_JOB_UPLOAD_ENABLED) === null) {
            const YES: vscode.QuickPickItem = {
                label: __('common.yes'),
                description: __('job.prepare.upload.yes.detail')
            };
            const NO: vscode.QuickPickItem = {
                label: __('common.no')
            };
            const item: vscode.QuickPickItem | undefined = await Util.pick(
                [YES, NO],
                __('job.prepare.upload.prompt')
            );
            if (item === YES) {
                await settings.update(SETTING_JOB_UPLOAD_ENABLED, true);
                await settings.update(SETTING_JOB_UPLOAD_EXCLUDE, []);
                await settings.update(SETTING_JOB_UPLOAD_INCLUDE, ['**/*.py']);
            } else if (item === NO) {
                await settings.update(SETTING_JOB_UPLOAD_ENABLED, false);
            } else {
                await settings.update(SETTING_JOB_UPLOAD_ENABLED, true);
                await settings.update(SETTING_JOB_UPLOAD_EXCLUDE, []);
                await settings.update(SETTING_JOB_UPLOAD_INCLUDE, ['**/*.py']);
                Util.info('job.prepare.upload.undefined.hint');
            }
        }
        if (settings.get(SETTING_JOB_GENERATEJOBNAME_ENABLED) === null) {
            const YES: vscode.QuickPickItem = {
                label: __('common.yes'),
                description: __('job.prepare.generate-job-name.yes.detail')
            };
            const NO: vscode.QuickPickItem = {
                label: __('common.no')
            };
            const item: vscode.QuickPickItem | undefined = await Util.pick(
                [YES, NO],
                __('job.prepare.generate-job-name.prompt')
            );
            if (item === YES) {
                await settings.update(SETTING_JOB_GENERATEJOBNAME_ENABLED, true);
            } else if (item === NO) {
                await settings.update(SETTING_JOB_GENERATEJOBNAME_ENABLED, false);
            } else {
                Util.info('job.prepare.generate-job-name.undefined.hint');
            }
        }
        // reload settings
        return vscode.workspace.getConfiguration(SETTING_SECTION_JOB);
    }

    private static replaceVariables({ cluster, config }: IJobParam): IPAIJobConfig {
        // Replace environment variable
        function replaceVariable(x: string): string {
            return x.replace('$PAI_JOB_NAME', config.jobName)
                .replace('$PAI_USER_NAME', cluster!.username);
        }
        for (const key of PAIJobManager.propertiesToBeReplaced) {
            const old: string | IPAITaskRole[] | undefined = config[key];
            if (typeof old === 'string') {
                config[key] = replaceVariable(old);
            }
        }
        if (config.taskRoles) {
            for (const role of config.taskRoles) {
                role.command = replaceVariable(role.command);
            }
        }
        return config;
    }

    // tslint:disable-next-line
    public async submitJob(input: IJobInput = {}): Promise<void> {
        const statusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Number.MAX_VALUE);
        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.prepare.status')}`;
        statusBarItem.show();

        try {
            const param: IJobParam | undefined = await this.prepareJobParam(input);
            if (!param) {
                // Error message has been shown.
                return;
            }

            if (!param.cluster) {
                param.cluster = await this.pickCluster();
            }

            // add job name suffix
            if (param.generateJobName) {
                param.config.jobName = `${param.config.jobName}_${uuid().substring(0, 8)}`;
            } else {
                try {
                    await request.get(`${this.getRestUrl(param.cluster)}/user/${param.cluster.username}/jobs/${param.config.jobName}`, {
                        headers: { Authorization: `Bearer ${await this.getToken(param.cluster)}` },
                        timeout: PAIJobManager.TIMEOUT,
                        json: true
                    });
                    // job exists
                    const ENABLE_GENERATE_SUFFIX: string = __('job.submission.name-exist.enable');
                    const CANCEL: string = __('common.cancel');
                    const res: string | undefined = await vscode.window.showErrorMessage(
                        __('job.submission.name-exist'),
                        ENABLE_GENERATE_SUFFIX,
                        CANCEL
                    );
                    if (res === ENABLE_GENERATE_SUFFIX) {
                        await vscode.workspace.getConfiguration(SETTING_SECTION_JOB).update(SETTING_JOB_GENERATEJOBNAME_ENABLED, true);
                        param.config.jobName = `${param.config.jobName}_${uuid().substring(0, 8)}`;
                    } else {
                        // cancel
                        return;
                    }
                } catch (e) {
                    if (e.response.body.code === 'NoJobError') {
                        // pass
                    } else {
                        throw new Error(e.status ? `${e.status}: ${e.response.body.message}` : e);
                    }
                }
            }

            // replace env variables
            PAIJobManager.replaceVariables(param);

            // auto upload
            statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.upload.status')}`;
            if (param.upload) {
                if (!await this.uploadCode(param)) {
                    return;
                }
            }

            // send job submission request
            statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.request.status')}`;
            try {
                await request.post(`${this.getRestUrl(param.cluster)}/user/${param.cluster.username}/jobs`, {
                    headers: { Authorization: `Bearer ${await this.getToken(param.cluster)}` },
                    form: param.config,
                    timeout: PAIJobManager.TIMEOUT,
                    json: true
                });
                const open: string = __('job.submission.success.open');
                void vscode.window.showInformationMessage(
                    __('job.submission.success'),
                    open
                ).then(async res => {
                    const url: string = `${getClusterWebPortalUri(param.cluster!)}/view.html?${querystring.stringify({
                        username: param.cluster!.username,
                        jobName: param.config.jobName
                    })}`;
                    if (res === open) {
                        await Util.openExternally(url);
                    }
                });
            } catch (e) {
                throw new Error(e.status ? `${e.status}: ${e.response.body.message}` : e);
            }
        } catch (e) {
            Util.err('job.submission.error', [e.message || e]);
        } finally {
            statusBarItem.dispose();
        }
    }

    // tslint:disable-next-line
    public async simulate(input: IJobInput = {}): Promise<void> {
        const statusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Number.MAX_VALUE);
        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.simulation.status')}`;
        statusBarItem.show();

        try {
            const param: IJobParam | undefined = await this.prepareJobParam(input);
            if (!param) {
                // Error message has been shown.
                return;
            }

            if (!param.cluster) {
                let pickCluster: boolean = false;
                // pick cluster if auto upload is disabled.
                if (!param.upload) {
                    pickCluster = true;
                }
                if (PAIJobManager.envNeedClusterInfo.some(
                    x => param.config.codeDir.includes(`$${x}`) || param.config.taskRoles.some(
                        y => y.command.includes(`$${x}`)
                    )
                )) {
                    pickCluster = true;
                }

                if (pickCluster) {
                    param.cluster = await this.pickCluster();
                }
            }

            // replace env variables if auto upload is disabled
            // extension will try to download files from hdfs instead of copying local files
            if (!param.upload) {
                PAIJobManager.replaceVariables(param);
            }

            // generate dockerfile
            const dockerfileDir: string = path.join(param.workspace, PAIJobManager.SIMULATION_DOCKERFILE_FOLDER);
            const jobDir: string = path.join(dockerfileDir, param.config.jobName);
            await fs.remove(jobDir);
            await fs.ensureDir(jobDir);
            let scriptName: string;
            if (os.platform() === 'win32') {
                scriptName = 'run-docker.cmd';
            } else {
                scriptName = 'run-docker.sh';
            }
            for (const role of param.config.taskRoles) {
                // 0. init
                const taskDir: string = path.join(jobDir, role.name);
                await fs.ensureDir(taskDir);
                const dockerfile: string[] = [];
                // 1. comments
                dockerfile.push('# Generated by OpenPAI VS Code Client');
                dockerfile.push(`# Job Name: ${param.config.jobName}`);
                dockerfile.push(`# Task Name: ${role.name}`);
                dockerfile.push('');
                // 2. from
                dockerfile.push(`FROM ${param.config.image}`);
                dockerfile.push('');
                // 3. source code
                const codeDir: string = path.join(taskDir, param.config.jobName);
                await fs.ensureDir(codeDir);
                if (param.upload) {
                    // copy from local
                    const projectFiles: string[] = await globby(param.upload.include, {
                        cwd: param.workspace, onlyFiles: true, absolute: true,
                        ignore: param.upload.exclude || []
                    });
                    await Promise.all(projectFiles.map(async file => {
                        await fs.copy(file, path.join(codeDir, path.relative(param.workspace, file)));
                    }));
                } else {
                    // copy from remote
                    const fsProvider: HDFSFileSystemProvider = (await getSingleton(HDFS)).provider!;
                    let remoteCodeDir: string = param.config.codeDir;
                    if (remoteCodeDir.startsWith('$PAI_DEFAULT_FS_URI')) {
                        remoteCodeDir = remoteCodeDir.substring('$PAI_DEFAULT_FS_URI'.length);
                    }
                    const remoteCodeUri: vscode.Uri = vscode.Uri.parse(`webhdfs://${getHDFSUriAuthority(param.cluster!)}${remoteCodeDir}`);
                    await fsProvider.copy(remoteCodeUri, vscode.Uri.file(codeDir), { overwrite: true });
                }
                dockerfile.push('WORKDIR /pai');
                dockerfile.push(`COPY ${param.config.jobName} /pai/${param.config.jobName}`);
                dockerfile.push('');
                // 4. env var
                dockerfile.push('ENV PAI_WORK_DIR /pai');
                dockerfile.push(`ENV PAI_JOB_NAME ${param.config.jobName}`);
                if (param.cluster) {
                    dockerfile.push(`ENV PAI_DEFAULT_FS_URI ${param.cluster.hdfs_uri}`);
                    dockerfile.push(`ENV PAI_USER_NAME ${param.cluster.username}`);
                    dockerfile.push(`ENV PAI_DATA_DIR ${param.config.dataDir}`);
                    dockerfile.push(`ENV PAI_CODE_DIR ${param.config.codeDir}`);
                    dockerfile.push(`ENV PAI_OUTPUT_DIR ${param.config.outputDir}`);
                }
                dockerfile.push('');
                // check unsupported env variables
                const supportedEnvList: string[] = [
                    'PAI_WORK_DIR',
                    'PAI_JOB_NAME',
                    'PAI_DEFAULT_FS_URI',
                    'PAI_USER_NAME',
                    'PAI_DATA_DIR',
                    'PAI_CODE_DIR',
                    'PAI_OUTPUT_DIR'
                ];
                let command: string = role.command;
                for (const env of supportedEnvList) {
                    command = command.replace(new RegExp(`\\$${env}`, 'g'), '');
                }
                if (command.includes('$PAI')) {
                    Util.warn('job.simulation.unsupported-env-var', role.command);
                }
                // 5. entrypoint
                dockerfile.push(`ENTRYPOINT ${role.command}`);
                dockerfile.push('');
                // 6. write dockerfile
                await fs.writeFile(path.join(taskDir, 'dockerfile'), dockerfile.join('\n'));
                // EX. write shell script
                const imageName: string = `pai-simulator-${param.config.jobName}-${role.name}`;
                await fs.writeFile(
                    path.join(taskDir, scriptName),
                    [
                        `docker build -t ${imageName} ${Util.quote(taskDir)}`,
                        `docker run --rm ${imageName}`,
                        `docker rmi ${imageName}`,
                        os.platform() === 'win32' ? 'pause' : 'read -p "Press [Enter] to continue ..."'
                    ].join('\n')
                );
            }

            const reveal: string = __('job.simulation.success-dialog.reveal');
            const runFirstTask: string = __('job.simulation.success-dialog.run-first-task');
            await vscode.window.showInformationMessage(
                __('job.simulation.success', [PAIJobManager.SIMULATION_DOCKERFILE_FOLDER, param.config.jobName, scriptName]),
                runFirstTask,
                reveal
            ).then((res) => {
                if (res === reveal) {
                    void opn(jobDir);
                } else if (res === runFirstTask) {
                    if (!this.simulateTerminal || !vscode.window.terminals.find(x => x.processId === this.simulateTerminal!.processId)) {
                        this.simulateTerminal = vscode.window.createTerminal('pai-simulator');
                    }
                    this.simulateTerminal.show(true);
                    if (os.platform() === 'win32') {
                        this.simulateTerminal.sendText(`cmd /k "${path.join(jobDir, param.config.taskRoles[0].name, scriptName)}"`);
                    } else {
                        this.simulateTerminal.sendText(`bash '${path.join(jobDir, param.config.taskRoles[0].name, scriptName)}'`);
                    }
                }
            });
        } catch (e) {
            Util.err('job.simulation.error', [e.message || e]);
        } finally {
            statusBarItem.dispose();
        }
    }

    private async pickCluster(): Promise<IPAICluster> {
        const clusterManager: ClusterManager = await getSingleton(ClusterManager);
        const pickResult: number | undefined = await clusterManager.pick();
        if (pickResult === undefined) {
            throw new Error(__('job.prepare.cluster.cancelled'));
        }
        return clusterManager.allConfigurations[pickResult];
    }

    private async prepareJobParam({ jobConfigPath, clusterIndex }: IJobInput): Promise<IJobParam | undefined> {
        const result: Partial<IJobParam> = {};
        // 1. job config
        if (!jobConfigPath) {
            Util.info('job.prepare.config.prompt');
            const folders: vscode.WorkspaceFolder[] | undefined = vscode.workspace.workspaceFolders;
            const jobConfigUrl: vscode.Uri[] | undefined = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                defaultUri: !isEmpty(folders) ? folders![0].uri : undefined
            });
            if (isEmpty(jobConfigUrl)) {
                Util.err('job.prepare.cluster.cancelled');
                return;
            }
            jobConfigPath = jobConfigUrl![0].fsPath;
        }
        const config: IPAIJobConfig = JSONC.parse(await fs.readFile(jobConfigPath, 'utf8'));
        const error: string | undefined = await Util.validateJSON(config, SCHEMA_JOB_CONFIG);
        if (error) {
            throw new Error(error);
        }
        result.config = config;
        // 2. workspace
        const workspace: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(jobConfigPath));
        if (!workspace) {
            throw new Error(__('common.workspace.nofolder'));
        }
        result.workspace = workspace.uri.fsPath;
        // 3. cluster
        if (clusterIndex) {
            const clusterManager: ClusterManager = await getSingleton(ClusterManager);
            result.cluster = clusterManager.allConfigurations[clusterIndex];
        }
        // 4. settings
        const settings: vscode.WorkspaceConfiguration = await PAIJobManager.ensureSettings();
        if (settings.get(SETTING_JOB_UPLOAD_ENABLED)) {
            result.upload = {
                include: settings.get<string[]>(SETTING_JOB_UPLOAD_INCLUDE)!,
                exclude: settings.get<string[]>(SETTING_JOB_UPLOAD_EXCLUDE)!
            };
        }
        result.generateJobName = settings.get(SETTING_JOB_GENERATEJOBNAME_ENABLED);

        return <IJobParam>result;
    }

    private getRestUrl(cluster: IPAICluster): string {
        let url: string = cluster.rest_server_uri;
        if (!url.endsWith('/')) {
            url += '/';
        }
        url += PAIJobManager.API_PREFIX;

        return Util.fixURL(url);
    }

    private async getToken(cluster: IPAICluster): Promise<string> {
        const id: string = getClusterIdentifier(cluster);
        let item: ITokenItem | undefined = this.cachedTokens.get(id);
        if (!item || Date.now() > item.expireTime) {
            const result: any = await request.post(`${this.getRestUrl(cluster)}/token`, {
                form: {
                    username: cluster.username,
                    password: cluster.password,
                    expiration: 4000
                },
                timeout: PAIJobManager.TIMEOUT,
                json: true
            });
            item = {
                token: result.token,
                expireTime: Date.now() + 3600 * 1000
            };
            this.cachedTokens.set(id, item);
        }

        return item.token;
    }

    private async uploadCode(param: IJobParam): Promise<boolean> {
        if (!param.cluster!.webhdfs_uri) {
            Util.err('pai.webhdfs.missing');
            return false;
        }

        try {
            // Avoid using vscode.workspace.findFiles for now - webhdfs:// folder in workspace will raise exception
            const projectFiles: string[] = await globby(param.upload!.include, {
                cwd: param.workspace, onlyFiles: true, absolute: true,
                ignore: param.upload!.exclude || []
            });
            const fsProvider: HDFSFileSystemProvider = (await getSingleton(HDFS)).provider!;
            let codeDir: string = param.config.codeDir;
            if (codeDir.startsWith('$PAI_DEFAULT_FS_URI')) {
                codeDir = codeDir.substring('$PAI_DEFAULT_FS_URI'.length);
            }
            const codeUri: vscode.Uri = vscode.Uri.parse(`webhdfs://${getHDFSUriAuthority(param.cluster!)}${codeDir}`);

            const total: number = projectFiles.length;
            const createdDirectories: Set<string> = new Set([ codeUri.path ]);
            await fsProvider.createDirectory(codeUri);

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: __('job.upload.status')
                },
                async (progress) => {
                    for (const [i, file] of projectFiles.entries()) {
                        const suffix: string = path.relative(param.workspace, file);
                        const baseFolder: string = path.dirname(suffix);
                        if (baseFolder !== '.') {
                            const baseFolderUri: vscode.Uri = Util.uriPathAppend(codeUri, path.dirname(suffix));
                            if (!createdDirectories.has(baseFolderUri.path)) {
                                createdDirectories.add(baseFolderUri.path);
                                await fsProvider.createDirectory(baseFolderUri);
                            }
                        }
                        progress.report({
                            message: __('job.upload.progress', [i + 1, total]),
                            increment: 1 / total * 100
                        });
                        await fsProvider.copy(vscode.Uri.file(file), Util.uriPathAppend(codeUri, suffix), { overwrite: true });
                    }
                }
            );

            return true;
        } catch (e) {
            Util.err('job.upload.error', [e]);
            return false;
        }
    }
}
