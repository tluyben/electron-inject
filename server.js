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

// The DOM inspection helper functions as a string
const domInspectionTools = `
// DOM Inspector Helper Functions
function findElementsByText(searchText, caseSensitive = false, rootElement = document.body) {
  const results = [];
  const searchTextLower = caseSensitive ? searchText : searchText.toLowerCase();
  
  function searchNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const content = caseSensitive ? node.textContent : node.textContent.toLowerCase();
      if (content.includes(searchTextLower)) {
        if (node.parentElement && !results.includes(node.parentElement)) {
          results.push(node.parentElement);
        }
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      for (const attr of node.attributes) {
        const attrValue = caseSensitive ? attr.value : attr.value.toLowerCase();
        if (attrValue.includes(searchTextLower)) {
          if (!results.includes(node)) {
            results.push(node);
            return;
          }
        }
      }
      
      for (const child of node.childNodes) {
        searchNode(child);
      }
    }
  }
  
  searchNode(rootElement);
  return results;
}

function highlightElements(elements, duration = 2000, color = 'rgba(255, 0, 0, 0.3)') {
  const originalStyles = [];
  
  elements.forEach(el => {
    originalStyles.push({
      element: el,
      outline: el.style.outline,
      backgroundColor: el.style.backgroundColor,
      transition: el.style.transition
    });
    
    el.style.outline = \`2px solid \${color}\`;
    el.style.backgroundColor = color;
    el.style.transition = 'all 0.5s ease-in-out';
  });
  
  setTimeout(() => {
    originalStyles.forEach(item => {
      item.element.style.outline = item.outline;
      item.element.style.backgroundColor = item.backgroundColor;
      item.element.style.transition = item.transition;
    });
  }, duration);
}

function getUniqueSelector(element) {
  if (!element) return null;
  if (element.id) return \`#\${element.id}\`;
  
  let selector = element.tagName.toLowerCase();
  
  if (element.className) {
    const classes = element.className.split(/\\s+/)
      .filter(c => c && c.length > 0)
      .map(c => \`.\${c}\`)
      .join('');
    selector += classes;
  }
  
  if (!element.parentElement || element.parentElement === document) {
    return selector;
  }
  
  const siblings = Array.from(element.parentElement.children);
  if (siblings.length > 1) {
    const index = siblings.indexOf(element) + 1;
    selector += \`:nth-child(\${index})\`;
  }
  
  return \`\${getUniqueSelector(element.parentElement)} > \${selector}\`;
}

function findElementsByStyle(styleProperties) {
  const allElements = document.querySelectorAll('*');
  const results = [];
  
  allElements.forEach(el => {
    const computedStyle = window.getComputedStyle(el);
    let match = true;
    
    for (const [property, value] of Object.entries(styleProperties)) {
      if (computedStyle[property] !== value) {
        match = false;
        break;
      }
    }
    
    if (match) {
      results.push(el);
    }
  });
  
  return results;
}

function findClickableElements() {
  const standardClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]');
  const attrClickable = document.querySelectorAll('[onclick], [data-click], [data-action]');
  const styleClickable = Array.from(document.querySelectorAll('*')).filter(el => {
    const style = window.getComputedStyle(el);
    return style.cursor === 'pointer';
  });
  
  return [...new Set([...standardClickable, ...attrClickable, ...styleClickable])];
}

function inspectElements(elements) {
  elements.forEach((el, index) => {
    console.group(\`Element \${index + 1} (\${el.tagName})\`);
    console.log('Element:', el);
    console.log('Text content:', el.textContent.trim().substring(0, 100) + (el.textContent.length > 100 ? '...' : ''));
    console.log('Unique selector:', getUniqueSelector(el));
    console.log('Attributes:', Array.from(el.attributes).map(attr => \`\${attr.name}="\${attr.value}"\`).join(', '));
    console.groupEnd();
  });
}

console.log('[DOM Inspector Tools] Initialized successfully');
`;

// Connect to the CDP instance
async function connectToCDP() {
  if (activeClient) {
    return activeClient;
  }

  try {
    console.log(`Connecting to CDP on port ${argv.port}...`);
    const client = await CDP({ port: argv.port });
    const { Runtime } = client;
    await Runtime.enable();
    
    console.log('Successfully connected to the Electron app');
    
    // Inject the DOM inspection tools
    await Runtime.evaluate({
      expression: domInspectionTools,
      returnByValue: true
    });
    
    activeClient = { client, Runtime };
    
    // Set up event handling to log messages from the app
    Runtime.consoleAPICalled(({ type, args }) => {
      const values = args.map(arg => arg.value || arg.description).join(' ');
      // Clear the current line
      process.stdout.clearLine();
      process.stdout.cursorTo(0);
      console.log(`[App ${type}]:`, values);
      // If we have an active readline interface, re-display the prompt and current input
      if (rl) {
        rl.prompt(true);
      }
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