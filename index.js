#!/usr/bin/env node

// disable depreciation warnings
process.removeAllListeners("warning");

// package.json is included to get the version number
const package = require("./package.json");

// system modules
const fs = require("fs");
const readline = require("readline");
const os = require("os");

// third party modules
const path = require("path");
const chalk = require("chalk");
const yaml = require("js-yaml");
const sanitizeFilename = require("sanitize-filename");
const macScreenPerms = require("mac-screen-capture-permissions");

// local modules
const speak = require("./lib/speak");
const analytics = require("./lib/analytics");
const log = require("./lib/logger");
const parser = require("./lib/parser");
const commander = require("./lib/commander");
const system = require("./lib/system");
const generator = require("./lib/generator");
const sdk = require("./lib/sdk");
const commands = require("./lib/commands");
const init = require("./lib/init");
const config = require("./lib/config");

const { showTerminal, hideTerminal } = require("./lib/focus-application");
const isValidVersion = require("./lib/valid-version");
const session = require("./lib/session");
const notify = require("./lib/notify");

let lastPrompt = "";
let terminalApp = "";
let commandHistory = [];
let executionHistory = [];
let errorCounts = {};
let errorLimit = 3;
let checkCount = 0;
let checkLimit = 3;
let rl;

// list of prompts that the user has given us
let tasks = [];

// get args from terminal
const args = process.argv.slice(2);

const commandHistoryFile = path.join(os.homedir(), ".testdriver_history");

const delay = (t) => new Promise((resolve) => setTimeout(resolve, t));

let getArgs = () => {
  let command = 0;
  let file = 1;

  // TODO use a arg parser library to simplify this
  if (
    args[command] == "--help" ||
    args[command] == "-h" ||
    args[file] == "--help" ||
    args[file] == "-h"
  ) {
    console.log("Command: testdriverai [init, run, edit] [yaml filepath]");
    process.exit(0);
  }

  if (args[command] == "init") {
    args[command] = "init";
  } else if (args[command] !== "run" && !args[file]) {
    args[file] = args[command];
    args[command] = "edit";
  } else if (!args[command]) {
    args[command] = "edit";
  }

  if (!args[file]) {
    // make testdriver directory if it doesn't exist
    let testdriverFolder = path.join(process.cwd(), "testdriver");
    if (!fs.existsSync(testdriverFolder)) {
      fs.mkdirSync(testdriverFolder);
    }

    args[file] = "testdriver/testdriver.yml";
  }

  // turn args[file] into local path
  if (args[file]) {
    args[file] = `${process.cwd()}/${args[file]}`;
    if (!args[file].endsWith(".yml")) {
      args[file] += ".yml";
    }
  }

  return { command: args[command], file: args[file] };
};

let a = getArgs();

const thisFile = a.file;
const thisCommand = a.command;

log.log("info", chalk.green(`Howdy! I'm TestDriver v${package.version}`));
log.log("info", chalk.dim(`Working on ${thisFile}`));
console.log("");
log.log("info", chalk.yellow(`This is beta software!`));
log.log("info", `Join our Discord for help`);
log.log("info", `https://discord.com/invite/cWDFW8DzPm`);
console.log("");

// individual run ID for this session
// let runID = new Date().getTime();

function fileCompleter(line) {
  line = line.slice(5); // remove /run
  const lastSepIndex = line.lastIndexOf(path.sep);
  let dir;
  let partial;
  if (lastSepIndex === -1) {
    dir = ".";
    partial = line;
  } else {
    dir = line.slice(0, lastSepIndex + 1);
    partial = line.slice(lastSepIndex + 1);
  }
  try {
    const dirPath = path.resolve(process.cwd(), dir);

    let files = fs.readdirSync(dirPath);
    files = files.map((file) => {
      const fullFilePath = path.join(dirPath, file);
      const fileStats = fs.statSync(fullFilePath);
      return file + (fileStats.isDirectory() ? path.sep : ""); // add path.sep for dir
    });
    const matches = files.filter((file) => file.startsWith(partial));

    return [matches.length ? matches : files, partial];
  } catch (e) {
    console.log(e);
    return [[], partial];
  }
}

function completer(line) {
  let completions =
    "/summarize /save /run /quit /explore /assert /undo /manual".split(" ");
  if (line.startsWith("/run ")) {
    return fileCompleter(line);
  } else {
    completions.concat(tasks);

    var hits = completions.filter(function (c) {
      return c.indexOf(line) == 0;
    });
    // show all completions if none found
    return [hits.length ? hits : completions, line];
  }
}

if (!fs.existsSync(commandHistoryFile)) {
  // make the file
  fs.writeFileSync(commandHistoryFile, "");
} else {
  commandHistory = fs
    .readFileSync(commandHistoryFile, "utf-8")
    .split("\n")
    .filter((line) => {
      return line.trim() !== "";
    })
    .reverse();
}

if (!commandHistory.length) {
  commandHistory = [
    "open google chrome",
    "type hello world",
    "click on the current time",
  ];
}

const exit = async (failed = true) => {
  await save();

  analytics.track("exit", { failed });

  // we purposly never resolve this promise so the process will hang
  return new Promise(() => {
    rl?.close();
    rl?.removeAllListeners();
    process.exit(failed ? 1 : 0);
  });
};

// creates a new "thread" in which the AI is given an error
// and responds. notice `actOnMarkdown` which will continue
// the thread until there are no more codeblocks to execute
const haveAIResolveError = async (error, markdown, depth = 0, undo = false) => {
  let eMessage = error.message ? error.message : error;

  let safeKey = JSON.stringify(eMessage);
  errorCounts[safeKey] = errorCounts[safeKey] ? errorCounts[safeKey] + 1 : 1;

  log.log("error", eMessage);

  if (process.env["DEV"]) {
    console.log(error, eMessage);
    console.log(error.stack);
  }

  log.prettyMarkdown(eMessage);

  // if we get the same error 3 times in `run` mode, we exit
  if (errorCounts[safeKey] > errorLimit - 1) {
    console.log(chalk.red("Error loop detected. Exiting."));
    console.log(eMessage);
    await summarize(eMessage);
    return await exit(true);
  }

  if (undo) {
    await popFromHistory();
  }

  let image;
  if (error.attachScreenshot) {
    image = await system.captureScreenBase64(0.5);
  } else {
    image = null;
  }

  speak("thinking...");
  notify("thinking...");
  log.log("info", chalk.dim("thinking..."), true);

  let response = await sdk
    .req("error", {
      description: eMessage,
      markdown,
      image,
    })
    .then((data) => data?.result);

  if (response) {
    return await actOnMarkdown(response, depth, true);
  }
};

// this is run after all possible codeblocks have been executed, but only at depth 0, which is the top level
// this checks that the task is "really done" using a screenshot of the desktop state
// it's likely that the task will not be complete and the AI will respond with more codeblocks to execute
const check = async () => {

  checkCount++;

  if (checkCount >= checkLimit) {
    log.log("info", chalk.red("Exploratory loop detected. Exiting."));
    await summarize("Check loop detected.");
    return await exit(true);
  }

  await delay(3000);

  console.log("");
  log.log("info", chalk.dim("checking..."), "testdriver");
  let image = await system.captureScreenBase64(0.5);
  let mousePosition = await system.getMousePosition();
  let activeWindow = await system.activeWin();

  return await sdk
    .req("check", { tasks, image, mousePosition, activeWindow })
    .then((data) => data?.result);
};

// command is transformed from a single yml entry generated by the AI into a JSON object
// it is mapped via `commander` to the `commands` module so the yaml
// parameters can be mapped to actual functions
const runCommand = async (command, depth) => {
  let yml = await yaml.dump(command);

  log.log("debug", `running command: \n\n${yml}`);

  try {
    let response;

    if (command.command == "embed") {
      response = await embed(command.file, depth);
    } else if (command.command == "if") {
      response = await iffy(
        command.condition,
        command.then,
        command.else,
        depth,
      );
    } else {
      response = await commander.run(command, depth);
    }

    if (response && typeof response === "string") {
      return await actOnMarkdown(response, depth);
    }
  } catch (error) {
    if (error.fatal) {
      console.log("");
      log.log("info", chalk.red("Fatal Error") + `\n${error.message}`);
      await summarize(error.message);
      return await exit(true);
    } else {
      return await haveAIResolveError(
        error,
        yaml.dump({ commands: [yml] }),
        depth,
        true,
      );
    }
  }
};

let lastCommand = new Date().getTime();
let csv = [["command,time"]];

const executeCommands = async (commands, depth, pushToHistory = false) => {
  if (commands?.length) {
    for (const command of commands) {
      if (pushToHistory) {
        executionHistory[executionHistory.length - 1]?.commands.push(command);
      }

      await runCommand(command, depth);

      let timeToComplete = (new Date().getTime() - lastCommand) / 1000;
      // console.log(timeToComplete, 'seconds')

      csv.push([command.command, timeToComplete]);
      lastCommand = new Date().getTime();
    }
  }
};

// note that commands are run in a recursive loop, so that the AI can respond to the output of the commands
// like `click-image` and `click-text` for example
const executeCodeBlocks = async (codeblocks, depth, pushToHistory = false) => {
  depth = depth + 1;

  log.log("debug", { message: "execute code blocks", depth });

  for (const codeblock of codeblocks) {
    let commands;

    try {
      commands = await parser.getCommands(codeblock);
    } catch (e) {
      return await haveAIResolveError(
        e,
        yaml.dump(parser.getYAMLFromCodeBlock(codeblock)),
        depth,
      );
    }

    await executeCommands(commands, depth, pushToHistory);
  }
};

// this is the main function that interacts with the ai, runs commands, and checks the results
// notice that depth is 0 here. when this function resolves, the task is considered complete
// notice the call to `check()` which validates the prompt is complete
const aiExecute = async (message, validateAndLoop = false) => {
  executionHistory.push({ prompt: lastPrompt, commands: [] });

  log.log("debug", "kicking off exploratory loop");

  // kick everything off
  await actOnMarkdown(message, 0, true);

  if (validateAndLoop) {
    log.log("debug", "exploratory loop resolved, check your work");

    let response = await check();

    console.log("");
    log.prettyMarkdown(response);

    let checkCodeblocks = [];
    try {
      checkCodeblocks = await parser.findCodeBlocks(response);
    } catch (error) {
      return await haveAIResolveError(error, response, 0);
    }

    log.log("debug", `found ${checkCodeblocks.length} codeblocks`);

    if (checkCodeblocks.length > 0) {
      log.log("debug", "check thinks more needs to be done");
      return await aiExecute(response, validateAndLoop);
    } else {
      log.log("debug", "seems complete, returning");
      return response;
    }
  }
};

const assert = async (expect) => {
  analytics.track("assert");

  let task = expect;
  if (!task) {
    // set task to last value of tasks
    let task = tasks[tasks.length - 1];

    // throw error if no task
    if (!task) {
      throw new Error("No task to assert");
    }
  }

  speak("thinking...");
  notify("thinking...");
  log.log("info", chalk.dim("thinking..."), true);

  let response = `\`\`\`yml
commands:
  - command: assert
    expect: ${expect}
\`\`\``;

  await aiExecute(response);

  await save({ silent: true });
};

// this function responds to the result of `promptUser()` which is the user input
// it kicks off the exploratory loop, which is the main function that interacts with the AI
const humanInput = async (currentTask, validateAndLoop = false) => {

  lastPrompt = currentTask;
  checkCount = 0;

  log.log("debug", "humanInput called");

  tasks.push(currentTask);

  speak("thinking...");
  notify("thinking...");
  log.log("info", chalk.dim("thinking..."), true);

  log.log("info", "");

  let image = await system.captureScreenBase64(0.5);
  let message = await sdk
    .req("input", {
      input: currentTask,
      mousePosition: await system.getMousePosition(),
      activeWindow: await system.activeWin(),
      image,
    })
    .then((data) => data?.result);

  log.prettyMarkdown(message);

  await aiExecute(message, validateAndLoop);

  log.log("debug", "showing prompt from humanInput response check");

  await save({ silent: true });
};

const generate = async (type) => {
  log.log("debug", "generate called", type);

  speak("thinking...");
  notify("thinking...");
  log.log("info", chalk.dim("thinking..."), true);

  log.log("info", "");

  let image = await system.captureScreenBase64(0.5);
  let message = await sdk
    .req("generate", {
      type,
      image,
    })
    .then((data) => data?.result);

  log.prettyMarkdown(message);

  let testPrompts = await parser.findGenerativePrompts(message);

  // for each testPrompt
  for (const testPrompt of testPrompts) {
    // with the contents of the testPrompt
    let fileName =
      sanitizeFilename(testPrompt.headings[0])
        .trim()
        .replace(/ /g, "-")
        .toLowerCase() + ".md";
    let path1 = path.join(process.cwd(), "testdriver", "generate", fileName);
    // create generate directory if it doesn't exist
    if (!fs.existsSync(path.join(process.cwd(), "testdriver", "generate"))) {
      fs.mkdirSync(path.join(process.cwd(), "testdriver", "generate"));
    }
    let list = testPrompt.listsOrdered[0];

    let contents = list
      .map((item, index) => `${index + 1}. /explore ${item}`)
      .join("\n");
    fs.writeFileSync(path1, contents);
  }
};

const popFromHistory = async (fullStep) => {
  log.log("info", chalk.dim("undoing..."), true);

  if (executionHistory.length) {
    if (fullStep) {
      executionHistory.pop();
    } else {
      executionHistory[executionHistory.length - 1].commands.pop();
    }
    if (!executionHistory[executionHistory.length - 1].commands.length) {
      executionHistory.pop();
    }
  }
};

const undo = async () => {
  analytics.track("undo");

  popFromHistory();
  await save();
};

const manualInput = async (commandString) => {
  analytics.track("manual input");

  let yml = await generator.manualToYml(commandString);

  let message = `\`\`\`yaml
${yml}
\`\`\``;

  await aiExecute(message, false);

  await save({ silent: true });
};

// this function is responsible for starting the recursive process of executing codeblocks
const actOnMarkdown = async (content, depth, pushToHistory = false) => {
  log.log("debug", {
    message: "actOnMarkdown called",
    depth,
  });

  let codeblocks = [];
  try {
    codeblocks = await parser.findCodeBlocks(content);
  } catch (error) {
    pushToHistory = false;
    return await haveAIResolveError(error, content, depth);
  }

  if (codeblocks.length) {
    let executions = await executeCodeBlocks(codeblocks, depth, pushToHistory);
    return executions;
  } else {
    return true;
  }
};

// simple function to backfill the chat history with a prompt and
// then call `promptUser()` to get the user input
const firstPrompt = async () => {
  // readline is what allows us to get user input
  rl = readline.createInterface({
    terminal: true,
    history: commandHistory,
    removeHistoryDuplicates: true,
    input: process.stdin,
    output: process.stdout,
    completer,
  });

  analytics.track("first prompt");

  rl.on("SIGINT", async () => {
    analytics.track("sigint");
    await exit(false);
  });

  // this is how we parse user input
  // notice that the AI is only called if the input is not a command
  rl.on("line", async (input) => {
    await setTerminalApp();

    setTerminalWindowTransparency(true);
    errorCounts = {};

    // append this to commandHistoryFile
    fs.appendFileSync(commandHistoryFile, input + "\n");

    analytics.track("input", { input });

    console.log(""); // adds a nice break between submissions

    let commands = input.split(" ");

    // if last character is a question mark, we assume the user is asking a question
    if (input.indexOf("/summarize") == 0) {
      await summarize();
    } else if (input.indexOf("/quit") == 0) {
      await exit();
    } else if (input.indexOf("/save") == 0) {
      await save({ filepath: commands[1] });
    } else if (input.indexOf("/explore") == 0) {
      await humanInput(commands.slice(1).join(" "), true);
    } else if (input.indexOf("/undo") == 0) {
      await undo();
    } else if (input.indexOf("/assert") == 0) {
      await assert(commands.slice(1).join(" "));
    } else if (input.indexOf("/manual") == 0) {
      await manualInput(commands.slice(1).join(" "));
    } else if (input.indexOf("/run") == 0) {
      await run(commands[1], commands[2]);
    } else if (input.indexOf("/generate") == 0) {
      await generate(commands[1]);
    } else {
      await humanInput(input, false);
    }

    setTerminalWindowTransparency(false);
    promptUser();
  });

  // if file exists, load it
  if (fs.existsSync(thisFile)) {
    analytics.track("load");
    let object = await generator.ymlToHistory(
      fs.readFileSync(thisFile, "utf-8"),
    );

    if (!object?.steps) {
      analytics.track("load invalid yaml");
      log.log("error", "Invalid YAML. No steps found.");
      console.log("Invalid YAML: " + thisFile);
      return await exit(true);
    }

    // push each step to executionHistory from { commands: {steps: [ { commands: [Array] } ] } }
    object.steps.forEach((step) => {
      executionHistory.push(step);
    });

    let yml = fs.readFileSync(thisFile, "utf-8");

    let markdown = `\`\`\`yaml
${yml}
\`\`\``;

    log.log("info", `Loaded test script ${thisFile}\n`);

    log.prettyMarkdown(`

${markdown}

New commands will be appended.
`);
  }

  promptUser();
};

let setTerminalWindowTransparency = async (hide) => {
  if (!config.TD_MINIMIZE) {
    return;
  }

  try {
    if (hide) {
      if (terminalApp) {
        hideTerminal(terminalApp);
      }
    } else {
      if (terminalApp) {
        showTerminal(terminalApp);
      }
    }
  } catch (e) {
    // Suppress error
    console.error("Caught exception:", e);
  }
};

// this function is responsible for summarizing the test script that has already executed
// it is what is saved to the `/tmp/oiResult.log.log` file and output to the action as a summary
let summarize = async (error = null) => {
  analytics.track("summarize");

  log.log("info", "");

  log.log("info", chalk.cyan("summarizing"));
  log.log("info", chalk.dim("reviewing test..."), true);

  // let text = prompts.summarize(tasks, error);
  let image = await system.captureScreenBase64(0.5);

  log.log("info", chalk.dim("summarizing..."), true);

  let reply = await sdk
    .req("summarize", {
      image,
      error: error?.toString(),
      tasks,
    })
    .then((data) => data?.result);

  let resultFile = "/tmp/oiResult.log.log";
  if (process.platform === "win32") {
    resultFile = "/Windows/Temp/oiResult.log.log";
  }
  // write reply to /tmp/oiResult.log.log
  fs.writeFileSync(resultFile, reply);

  log.prettyMarkdown(reply);
};

// this function is responsible for saving the regression test script to a file
let save = async ({ filepath = thisFile, silent = false } = {}) => {
  analytics.track("save", { silent });

  if (!silent) {
    log.log("info", chalk.dim("saving..."), true);
    console.log("");
  }

  if (!executionHistory.length) {
    return;
  }

  // write reply to /tmp/oiResult.log.log
  let regression = await generator.historyToYml(executionHistory);
  try {
    fs.writeFileSync(filepath, regression);
  } catch (e) {
    log.log("error", e.message);
    console.log(e);
  }

  if (!silent) {
    log.prettyMarkdown(`Current test script:

\`\`\`yaml
${regression}
\`\`\``);

    // console.log(csv.join('\n'))

    const fileName = filepath.split("/").pop();
    if (!silent) {
      log.log("info", chalk.dim(`saved as ${fileName}`));
    }
  }
};

// this will load a regression test from a file location
// it parses the markdown file and executes the codeblocks exactly as if they were
// generated by the AI in a single prompt
let run = async (file, overwrite = false) => {
  setTerminalWindowTransparency(true);

  log.log("info", chalk.cyan(`running ${file}...`));

  executionHistory = [];
  let yml;

  //wrap this in try/catch so if the file doesn't exist output an error message to the user
  try {
    yml = fs.readFileSync(file, "utf-8");
  } catch (e) {
    console.log(e);
    log.log("error", "File not found. Please try again.");
    console.log(`File not found: ${file}`);
    console.log(`Current directory: ${process.cwd()}`);

    await summarize("File not found");
    await exit(true);
  }

  let ymlObj = null;
  try {
    ymlObj = await yaml.load(yml);
  } catch (e) {
    console.log(e);
    log.log("error", "Invalid YAML. Please try again.");
    console.log(`Invalid YAML: ${file}`);

    await summarize("Invalid YAML");
    await exit(true);
  }

  if (ymlObj.version) {
    let valid = isValidVersion(ymlObj.version);
    if (!valid) {
      log.log("error", "Version mismatch. Please try again.");
      console.log(
        `Version mismatch: ${file}. Trying to run a test with v${ymlObj.version} test when this package is v${package.version}.`,
      );

      await summarize("Version mismatch");
      await exit(true);
    }
  }

  executionHistory = [];

  for (const step of ymlObj.steps) {
    log.log("info", ``, null);
    log.log("info", chalk.cyan(`${step.prompt || "no prompt"}`), null);

    executionHistory.push({
      prompt: step.prompt,
      commands: [], // run will overwrite the commands
    });

    let markdown = `\`\`\`yaml
${yaml.dump(step)}
\`\`\``;

    log.log("debug", markdown);
    log.log("debug", "load calling actOnMarkdown");

    lastPrompt = step.prompt;
    await actOnMarkdown(markdown, 0, true);
  }

  if (overwrite) {
    await save({ filepath: file });
  }

  setTerminalWindowTransparency(false);

  await summarize();
  await exit(false);
};

const promptUser = () => {
  rl.prompt(true);
};

const setTerminalApp = async () => {
  let win = await system.activeWin();
  if (process.platform === "win32") {
    terminalApp = win?.title || "";
  } else {
    terminalApp = win?.owner?.name || "";
  }
};

const iffy = async (condition, then, otherwise, depth) => {
  analytics.track("if", { condition });

  log.log("info", generator.jsonToManual({ command: "if", condition }));

  let response = await commands.assert(condition);

  depth = depth + 1;

  if (response) {
    return await executeCommands(then, depth);
  } else {
    return await executeCommands(otherwise, depth);
  }
};

const embed = async (file, depth) => {
  analytics.track("embed", { file });

  log.log("info", generator.jsonToManual({ command: "embed", file }));

  depth = depth + 1;

  log.log("info", `${file} (start)`);

  // get the current wowrking directory where this file is being executed
  let cwd = process.cwd();

  // if the file is not an absolute path, we will try to resolve it
  if (!path.isAbsolute(file)) {
    file = path.resolve(cwd, file);
  }

  // check if the file exists
  if (!fs.existsSync(file)) {
    throw `Embedded file not found: ${file}`;
  }

  // read the file contents
  let contents = fs.readFileSync(file, "utf8");

  // for each step, run each command
  let steps = yaml.load(contents).steps;
  // for each step, execute the commands

  for (const step of steps) {
    await executeCommands(step.commands, depth);
  }

  log.log("info", `${file} (end)`);
};

(async () => {
  // @todo add-auth
  // if (!process.env.DASHCAM_API_KEY) {
  //   log.log('info', chalk.red(`You must supply an API key`), 'system')
  //   log.log('info', `Supply your API key with the \`DASHCAM_API_KEY\` environment variable.`, 'system');
  //   log.log('info', 'You can get a key in the Dashcam Discord server: https://discord.com/invite/cWDFW8DzPm', 'system')
  //   process.exit();
  // }

  // await sdk.auth();

  // if os is mac, check for screen capture permissions
  if (
    process.platform === "darwin" &&
    !macScreenPerms.hasScreenCapturePermission()
  ) {
    log.log("info", chalk.red("Screen capture permissions not enabled."));
    log.log(
      "info",
      "You must enable screen capture permissions for the application calling `testdriverai`.",
    );
    log.log(
      "info",
      "Read More: https://docs.testdriver.ai/faq/screen-recording-permissions-mac-only",
    );
    analytics.track("noMacPermissions");
    return exit();
  }

  if (thisCommand !== "run") {
    speak("Howdy! I am TestDriver version " + package.version);

    console.log(
      chalk.red("Warning!") +
        chalk.dim(" TestDriver sends screenshots of the desktop to our API."),
    );
    console.log(
      chalk.dim("https://docs.testdriver.ai/security-and-privacy/agent"),
    );
    console.log("");
  }

  await setTerminalApp();

  // should be start of new session
  let sessionRes = await sdk
    .req("session/start", {
      systemInformationOsInfo: await system.getSystemInformationOsInfo(),
      mousePosition: await system.getMousePosition(),
      activeWindow: await system.activeWin(),
    })
    .then((data) => data?.result);

  session.set(sessionRes);

  analytics.track("command", { command: thisCommand, file: thisFile });

  if (thisCommand == "edit") {
    firstPrompt();
  } else if (thisCommand == "run") {
    errorLimit = 100;
    run(thisFile);
  } else if (thisCommand == "init") {
    init();
  }
})();

process.on("uncaughtException", async (err) => {
  analytics.track("uncaughtException", { err });
  console.error("Uncaught Exception:", err);
  // You might want to exit the process after handling the error
  await exit(true);
});

process.on("unhandledRejection", async (reason, promise) => {
  analytics.track("unhandledRejection", { reason, promise });
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Optionally, you might want to exit the process
  await exit(true);
});
