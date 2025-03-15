const express = require('express');
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Parse command-line arguments
const argv = yargs(hideBin(process.argv))
  .option('port', {
    alias: 'p',
    description: 'DevTools debugging port to connect to',
    type: 'number',
    default: 9222
  })
  .option('script', {
    alias: 's',
    description: 'JavaScript file to execute in the Electron app',
    type: 'string'
  })
  .option('server-port', {
    alias: 'sp',
    description: 'Port for the Express server',
    type: 'number',
    default: 3000
  })
  .help()
  .alias('help', 'h')
  .argv;

const app = express();
app.use(express.json());

// Store the active CDP client globally so we can reuse it
let activeClient = null;

// Connect to the CDP instance
async function connectToCDP() {
  if (activeClient) {
    // console.log('Using existing CDP connection');
    return activeClient;
  }

  try {
    console.log(`Connecting to CDP on port ${argv.port}...`);
    const client = await CDP({ port: argv.port });
    const { Runtime } = client;
    await Runtime.enable();
    
    console.log('Successfully connected to the Electron app');
    activeClient = { client, Runtime };
    
    // Set up event handling to log messages from the app
    Runtime.consoleAPICalled(({ type, args }) => {
      const values = args.map(arg => arg.value || arg.description).join(' ');
      console.log(`[App ${type}]:`, values);
    });
    
    return activeClient;
  } catch (err) {
    console.error('Failed to connect to CDP:', err.message);
    throw err;
  }
}

// Execute JavaScript in the Electron app
async function executeJS(code) {
  try {
    const { Runtime } = await connectToCDP();
    const result = await Runtime.evaluate({
      expression: code,
      returnByValue: true,
      awaitPromise: true
    });
    
    if (result.exceptionDetails) {
      return {
        error: result.exceptionDetails.text,
        stack: result.exceptionDetails.exception?.description || "No stack available"
      };
    }
    
    // Check if the result has a value that's not undefined
    if (result.result.value !== undefined) {
      return result.result.value;
    } 
    
    // For objects that can't be serialized (showing as undefined)
    if (result.result.type === 'object' && result.result.className) {
      return `[${result.result.className}]`;
    }
    
    // For functions
    if (result.result.type === 'function') {
      return `[Function]`;
    }
    
    // For primitive types with no value
    return result.result.type === 'undefined' ? undefined : `[${result.result.type}]`;
  } catch (err) {
    return { error: err.message };
  }
}

  // API endpoint to execute JavaScript
app.post('/execute', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }
  
  try {
    const result = await executeJS(code);
    if (result && result.error) {
      return res.status(400).json(result);
    }
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start the Express server
const serverPort = argv.serverPort;
app.listen(serverPort, () => {
  console.log(`Server listening on port ${serverPort}`);
  console.log(`Targeting Electron app on debugging port ${argv.port}`);
  
  // If a script was provided, execute it
  if (argv.script) {
    const scriptPath = path.resolve(argv.script);
    console.log(`Executing script: ${scriptPath}`);
    
    try {
      const scriptContent = fs.readFileSync(scriptPath, 'utf8');
      executeJS(scriptContent)
        .then(result => {
          if (result !== undefined) {
            console.log('Script execution result:', result);
          }
          startREPL();
        })
        .catch(err => {
          console.error('Script execution failed:', err);
          startREPL();
        });
    } catch (err) {
      console.error(`Failed to read script file: ${err.message}`);
      startREPL();
    }
  } else {
    // Start the REPL interface
    startREPL();
  }
});

// Make rl globally accessible for console events
let rl;

// Interactive REPL functionality
function startREPL() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 100,
    prompt: 'electron-repl> '
  });
  
  // Create a history array to store commands
  const history = [];
  let historyIndex = 0;
  
  // Connect to CDP before starting the REPL
  connectToCDP()
    .then(() => {
      console.log('\n=== Electron DevTools REPL ===');
      console.log('Type JavaScript code to execute in the Electron app');
      console.log('Special commands:');
      console.log('  .exit - Exit the REPL');
      console.log('  .clear - Clear the console');
      console.log('  .load <file> - Load and execute a JavaScript file');
      console.log('  .help - Show this help message');
      console.log('Use up/down arrows to navigate command history\n');
      
      rl.prompt();
      
      rl.on('line', async (line) => {
        line = line.trim();
        
        // Skip empty lines
        if (!line) {
          rl.prompt();
          return;
        }
        
        // Add to history unless it's a duplicate of the last entry
        if (history.length === 0 || history[history.length - 1] !== line) {
          history.push(line);
          historyIndex = history.length;
        }
        
        // Handle special commands
        if (line === '.exit') {
          if (activeClient) {
            activeClient.client.close();
          }
          rl.close();
          process.exit(0);
        } else if (line === '.clear') {
          console.clear();
          rl.prompt();
        } else if (line === '.help') {
          console.log('Special commands:');
          console.log('  .exit - Exit the REPL');
          console.log('  .clear - Clear the console');
          console.log('  .load <file> - Load and execute a JavaScript file');
          console.log('  .help - Show this help message');
          rl.prompt();
        } else if (line.startsWith('.load ')) {
          const filePath = line.slice(6).trim();
          try {
            const scriptContent = fs.readFileSync(filePath, 'utf8');
            console.log(`Executing file: ${filePath}`);
            const result = await executeJS(scriptContent);
            if (result !== undefined) {
              console.log(result);
            }
          } catch (err) {
            console.error(`Failed to load or execute file: ${err.message}`);
          }
          rl.prompt();
        } else {
          // Execute JavaScript in the Electron app
          try {
            const result = await executeJS(line);
            // Only display result if it's not undefined and not a console.log statement (which already outputs)
            if (result !== undefined && !line.trim().startsWith('console.log')) {
              console.log(result);
            }
          } catch (err) {
            console.error('Execution error:', err);
          }
          rl.prompt();
        }
      });
      
      // Handle Ctrl+C to exit gracefully
      rl.on('SIGINT', () => {
        console.log('\nExiting...');
        if (activeClient) {
          activeClient.client.close();
        }
        rl.close();
        process.exit(0);
      });
      
      // Custom key handling for history navigation
      rl.input.on('keypress', (_, key) => {
        if (!key) return;
        
        if (key.name === 'up') {
          if (historyIndex > 0) {
            historyIndex--;
            rl.line = history[historyIndex];
            rl.cursor = rl.line.length;
            rl._refreshLine();
          }
        } else if (key.name === 'down') {
          if (historyIndex < history.length - 1) {
            historyIndex++;
            rl.line = history[historyIndex];
            rl.cursor = rl.line.length;
            rl._refreshLine();
          } else if (historyIndex === history.length - 1) {
            historyIndex = history.length;
            rl.line = '';
            rl.cursor = 0;
            rl._refreshLine();
          }
        }
      });
    })
    .catch(err => {
      console.error('Failed to start REPL:', err);
      process.exit(1);
    });
}

// Handle clean shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (activeClient) {
    activeClient.client.close();
  }
  process.exit(0);
});

process.on('exit', () => {
  if (activeClient) {
    activeClient.client.close();
  }
});