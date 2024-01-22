#!/usr/bin/env node

'use strict';

let chalk;
const fs = require('fs');
const markdownLinkCheck = require('.');
const path = require('path');
const pkg = require('./package.json');
const program = require('commander');
const url = require('url');

class Input {
    constructor(filenameForOutput, stream, opts) {
        this.filenameForOutput = filenameForOutput;
        this.stream = stream;
        this.opts = opts;
    }
}

function commaSeparatedCodesList(value) {
    return value.split(',').map(function(item) {
        return parseInt(item, 10);
    });
}

/**
 * Load all files in the rootFolder and all subfolders that end with .md
 */
function loadAllMarkdownFiles(rootFolder = '.') {
    const fs = require('fs');
    const path = require('path');
    const files = [];
    fs.readdirSync(rootFolder).forEach(file => {
        const fullPath = path.join(rootFolder, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            files.push(...loadAllMarkdownFiles(fullPath));
        } else if (fullPath.endsWith('.md')) {
            files.push(fullPath);
        }
    });
    return files;
}


function getInputs() {
    const inputs = [];

    program
        .version(pkg.version)
        .option('-p, --progress', 'show progress bar')
        .option('-n, --parallel <number>', 'number of parallel requests (default: 2)')
        .option('-c, --config [config]', 'apply a config file (JSON), holding e.g. url specific header configuration')
        .option('-q, --quiet', 'displays errors only')
        .option('-v, --verbose', 'displays detailed error information')
        .option('-a, --alive <code>', 'comma separated list of HTTP codes to be considered as alive', commaSeparatedCodesList)
        .option('-r, --retry', 'retry after the duration indicated in \'retry-after\' header when HTTP code is 429')
        .option('--projectBaseUrl <url>', 'the URL to use for {{BASEURL}} replacement')
        .arguments('[filenamesOrUrls...]')
        .action(function (filenamesOrUrls) {
            let filenameForOutput;

            if (!filenamesOrUrls.length) {
                // read from stdin unless a filename is given
                inputs.push(new Input(filenameForOutput, process.stdin, {}));
            }

            for (const filenameOrUrl of filenamesOrUrls) {
                filenameForOutput = filenameOrUrl;
                let baseUrl = '';
                if (/https?:/.test(filenameOrUrl)) {
                    
                    try { // extract baseUrl from supplied URL
                        const parsed = url.parse(filenameOrUrl);
                        delete parsed.search;
                        delete parsed.hash;
                        if (parsed.pathname.lastIndexOf('/') !== -1) {
                            parsed.pathname = parsed.pathname.substr(0, parsed.pathname.lastIndexOf('/') + 1);
                        }
                        baseUrl = url.format(parsed);
                        console.log('baseUrl: ' + baseUrl)
                        inputs.push(new Input(filenameForOutput, null, {baseUrl: baseUrl}));
                    } catch (err) { /* ignore error */
                        }
                } else {
                    const stats = fs.statSync(filenameOrUrl);
                    if (stats.isDirectory()){
                        let files = loadAllMarkdownFiles(filenameOrUrl)
                        for (let file of files) {
                            filenameForOutput = file;
                            baseUrl = 'file://' + path.dirname(path.resolve(file));
                            inputs.push(new Input(filenameForOutput, null, {baseUrl: baseUrl}));
                        }
                    } else {
                        baseUrl = 'file://' + path.dirname(path.resolve(filenameOrUrl));
                        inputs.push(new Input(filenameForOutput, null, {baseUrl: baseUrl}));    
                    }
                }

            }
        }
    ).parse(process.argv);

    for (const input of inputs) {
        input.opts.showProgressBar = (program.opts().progress === true); // force true or undefined to be true or false.
        input.opts.quiet = (program.opts().quiet === true);
        input.opts.verbose = (program.opts().verbose === true);
        input.opts.retryOn429 = (program.opts().retry === true);
        input.opts.parallel = program.opts().parallel;
        input.opts.aliveStatusCodes = program.opts().alive;
        const config = program.opts().config;
        if (config) {
            input.opts.config = config.trim();
        }
        
        if (program.projectBaseUrl) {
            input.opts.projectBaseUrl = `file://${program.projectBaseUrl}`;
        } else {
            // set the default projectBaseUrl to the current working directory, so that `{{BASEURL}}` can be resolved to the project root.
            input.opts.projectBaseUrl = `file://${process.cwd()}`;
        }
    }

    return inputs;
}

async function loadConfig(config) {
    return new Promise((resolve) => {
        fs.access(config, (fs.constants || fs).R_OK, function (err) {
            if (!err) {
                let configStream = fs.createReadStream(config);
                let configData = '';

                configStream.on('data', function (chunk) {
                    configData += chunk.toString();
                }).on('end', function () {
                    resolve(JSON.parse(configData));
                });
            }
            else {
                console.error(chalk.red('\nERROR: Config file not accessible.'));
                process.exit(1);
            }
        });
    });
}

async function processInput(filenameForOutput, stream, opts) {
    let markdown = ''; // collect the markdown data, then process it
    
    if (/https?:/.test(filenameForOutput)) {
        let res = await fetch(filenameForOutput);
        markdown = await res.text();
    } else {
        markdown = fs.readFileSync(filenameForOutput, 'utf8')
    }

    if (!opts.quiet && filenameForOutput) {
        console.log(chalk.cyan('\nFILE: ' + filenameForOutput));
    }

    if (opts.config) {
        let config = await loadConfig(opts.config);

        opts.ignorePatterns = config.ignorePatterns;
        opts.replacementPatterns = config.replacementPatterns;
        opts.httpHeaders = config.httpHeaders;
        opts.timeout = config.timeout;
        opts.ignoreDisable = config.ignoreDisable;
        opts.retryOn429 = config.retryOn429;
        opts.retryCount = config.retryCount;
        opts.fallbackRetryDelay = config.fallbackRetryDelay;
        opts.aliveStatusCodes = config.aliveStatusCodes;
        opts.parallel = opts.parallel || config.parallel;
    }

    await runMarkdownLinkCheck(filenameForOutput, markdown, opts);
}

async function runMarkdownLinkCheck(filenameForOutput, markdown, opts) {
    const statusLabels = {
        alive: chalk.green('✓'),
        dead: chalk.red('✖'),
        ignored: chalk.gray('/'),
        error: chalk.yellow('⚠'),
    };

    return new Promise((resolve, reject) => {
        markdownLinkCheck(markdown, opts, function (err, results) {
            if (err) {
                console.error(chalk.red('\n  ERROR: something went wrong!'));
                console.error(err.stack);
                reject();
            }

            if (results.length === 0 && !opts.quiet) {
                console.log(chalk.yellow('  No hyperlinks found!'));
            }
            results.forEach(function (result) {
                // Skip messages for non-deadlinks in quiet mode.
                if (opts.quiet && result.status !== 'dead') {
                    return;
                }

                if (opts.verbose) {
                    if (result.err) {
                        console.log('  [%s] %s → Status: %s %s', statusLabels[result.status], result.link, result.statusCode, result.err);
                    } else {
                        console.log('  [%s] %s → Status: %s', statusLabels[result.status], result.link, result.statusCode);
                    }
                }
                else if(!opts.quiet) {
                    console.log('  [%s] %s', statusLabels[result.status], result.link);
                }
            });

            if(!opts.quiet){
                console.log('\n  %s links checked.', results.length);
            }

            if (results.some((result) => result.status === 'dead')) {
                let deadLinks = results.filter(result => { return result.status === 'dead'; });
                if(!opts.quiet){
                    console.error(chalk.red('\n  ERROR: %s dead links found!'), deadLinks.length);
                } else {
                    console.error(chalk.red('\n  ERROR: %s dead links found in %s !'), deadLinks.length, filenameForOutput);
                }
                deadLinks.forEach(function (result) {
                    console.log('  [%s] %s → Status: %s', statusLabels[result.status], result.link, result.statusCode);
                });
                reject();
            }

            resolve();
        });
    });
}

async function main() {
    chalk = (await import('chalk')).default;
    const inputs = getInputs();

    // start time
    console.time("Links checked in")

    let isOk = true;
    for await (const input of inputs) {
        try {
            await processInput(input.filenameForOutput, input.stream, input.opts);
        } catch (err) {
            isOk = false;
        }
    }
    console.timeEnd("Links checked in")
    console.log('Exit code ' + (isOk ? 0 : 1));
    process.exit(isOk ? 0 : 1);
}

main();