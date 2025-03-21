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
function findElementsByTextInfo(searchText) {
  const elements = findElementsByText(searchText);
  return elements.map(el => ({
    tagName: el.tagName,
    id: el.id || null,
    classes: el.className || null,
    textContent: el.textContent.substring(0, 100),
    selector: safeSelector(el)
  }));
}

function generateSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  
  // Try different selector strategies in order of preference
  const strategies = [
    // Strategy 1: ID-based selector
    function() {
      if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) {
        return '#' + CSS.escape(element.id);
      }
      return null;
    },
    
    // Strategy 2: Unique class combination
    function() {
      if (element.className) {
        const classes = element.className.trim().split(/\s+/);
        const usefulClasses = classes
          .filter(function(cls) {
            return cls && 
                   !cls.startsWith('__') && 
                   !/^[a-z][a-z0-9]+-[a-f0-9]+$/i.test(cls) && 
                   cls.length < 25;
          });
        
        // Try combinations of classes from most specific to least
        for (let i = Math.min(3, usefulClasses.length); i > 0; i--) {
          const classSelector = element.tagName.toLowerCase() + '.' + 
            usefulClasses.slice(0, i).map(function(c) { return CSS.escape(c); }).join('.');
          if (document.querySelectorAll(classSelector).length === 1) {
            return classSelector;
          }
        }
      }
      return null;
    },
    
    // Strategy 3: Attribute-based selector
    function() {
      const uniqueAttributes = ['name', 'type', 'role', 'data-testid', 'aria-label', 'title', 'placeholder'];
      for (const attr of uniqueAttributes) {
        if (element.hasAttribute(attr)) {
          const selector = element.tagName.toLowerCase() + '[' + attr + '="' + 
            CSS.escape(element.getAttribute(attr)) + '"]';
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }
      }
      return null;
    },
    
    // Strategy 4: Parent context with nth-of-type
    function() {
      if (element.parentElement && element.parentElement !== document.body) {
        const parent = element.parentElement;
        const parentSelector = generateSelector(parent);
        if (parentSelector) {
          const siblings = Array.from(parent.children).filter(function(child) {
            return child.tagName === element.tagName;
          });
          const index = siblings.indexOf(element) + 1;
          const selector = parentSelector + ' > ' + element.tagName.toLowerCase() + 
            ':nth-of-type(' + index + ')';
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }
      }
      return null;
    },
    
    // Strategy 5: Fallback - Position-based selector
    function() {
      let current = element;
      const parts = [];
      let depth = 0;
      const maxDepth = 3;
      
      while (current && current !== document.body && depth < maxDepth) {
        const tag = current.tagName.toLowerCase();
        const index = Array.from(current.parentElement.children)
          .filter(function(child) { return child.tagName === current.tagName; })
          .indexOf(current) + 1;
        
        parts.unshift(tag + ':nth-child(' + index + ')');
        current = current.parentElement;
        depth++;
        
        // Test if the current path is unique
        const testSelector = parts.join(' > ');
        if (document.querySelectorAll(testSelector).length === 1) {
          return testSelector;
        }
      }
      
      // If we get here, return the full path as last resort
      return parts.join(' > ');
    }
  ];
  
  // Try each strategy in order until we get a valid selector
  for (const strategy of strategies) {
    try {
      const selector = strategy();
      if (selector && testSelector(element, selector)) {
        return selector;
      }
    } catch (e) {
      console.warn('Selector strategy failed:', e);
    }
  }
  
  // Ultimate fallback: full path from body
  try {
    let current = element;
    const parts = [];
    while (current && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const index = Array.from(current.parentElement.children).indexOf(current) + 1;
      parts.unshift(tag + ':nth-child(' + index + ')');
      current = current.parentElement;
    }
    parts.unshift('body');
    return parts.join(' > ');
  } catch (e) {
    // Last resort if everything fails
    return element.tagName.toLowerCase() + ':nth-child(' + 
      (Array.from(element.parentElement.children).indexOf(element) + 1) + ')';
  }
}

function testSelector(element, selector) {
  try {
    const found = document.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch (e) {
    console.error('Invalid selector:', selector, e);
    return false;
  }
}

function safeSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  
  // Try the main approach first
  try {
    const selector = generateSelector(element);
    if (selector && testSelector(element, selector)) {
      return selector;
    }
  } catch (e) {
    console.warn('Error generating primary selector', e);
  }
  
  // Fallback: Use tag name with position
  try {
    if (element.parentElement) {
      const tagName = element.tagName.toLowerCase();
      const siblings = Array.from(element.parentElement.children);
      const index = siblings.indexOf(element) + 1;
      
      const selector = \`\${tagName}:nth-child(\${index})\`;
      if (testSelector(element, selector)) {
        return selector;
      }
      
      // Add parent tag if needed
      if (element.parentElement !== document.body) {
        const parentTag = element.parentElement.tagName.toLowerCase();
        const parentSelector = \`\${parentTag} > \${selector}\`;
        if (testSelector(element, parentSelector)) {
          return parentSelector;
        }
      }
    }
  } catch (e) {
    console.warn('Error generating fallback selector', e);
  }
  
  // Final fallback: Use JS path
  try {
    // Create a simple JS path for querySelector
    const path = [];
    let currentElement = element;
    while (currentElement && currentElement !== document.body && path.length < 3) {
      const tag = currentElement.tagName.toLowerCase();
      const index = Array.from(currentElement.parentElement.children)
        .filter(c => c.tagName === currentElement.tagName)
        .indexOf(currentElement) + 1;
      
      path.unshift(\`\${tag}:nth-of-type(\${index})\`);
      currentElement = currentElement.parentElement;
      
      // Test if the path so far is unique
      const testPath = path.join(' > ');
      if (testSelector(element, testPath)) {
        return testPath;
      }
    }
  } catch (e) {
    console.warn('Error generating JS path selector', e);
  }
  
  // Could not generate a reliable selector
  return null;
}

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
    console.log('Unique selector:', safeSelector(el));
    console.log('Attributes:', Array.from(el.attributes).map(attr => \`\${attr.name}="\${attr.value}"\`).join(', '));
    console.groupEnd();
  });
}

function hitEnter(el) {
  el.dispatchEvent(new KeyboardEvent('keydown',{key: 'Enter',code: 'Enter',keyCode: 13,which: 13,bubbles: true,cancelable: true}));
}

function parseStreamingJSON(text) {
  // Handle multiple JSON objects separated by newlines (common in streaming APIs)
  if (text.includes('\\n')) {
    return text.split('\\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return line;
        }
      });
  }
  
  // Try to parse a single JSON object
  try {
    return JSON.parse(text);
  } catch (e) {
    // For streaming that sends "data: {json}" format (SSE)
    if (text.startsWith('data:')) {
      try {
        const jsonPart = text.substring(5).trim();
        return JSON.parse(jsonPart);
      } catch (e2) {
        return text;
      }
    }
    return text;
  }
}

function monitorApiCall(urlPattern, method, waitForCall = true, callback = null, timeout = 30000) {
  return new Promise((resolve, reject) => {
    // Create a regex from the pattern
    const urlRegex = new RegExp(urlPattern);
    // Track if we found a matching request
    let foundRequest = false;
    // For tracking timeout
    let timeoutId = null;
    
    // Collection of all messages in order
    const messageLog = [];
    
    // Function to add messages to the log
    function logMessage(message) {
      // Add timestamp if not present
      if (!message.timestamp) {
        message.timestamp = Date.now();
      }
      
      // Add to log
      messageLog.push(message);
      
      // Forward to callback if provided
      if (callback) {
        callback(message);
      }
    }
    
    // Set timeout if specified
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        cleanupMonitoring();
        reject(new Error(\`Timeout after \${timeout}ms waiting for \${method} \${urlPattern}\`));
      }, timeout);
    }
    
    // Cleanup function to remove our interceptors
    function cleanupMonitoring() {
      window.fetch = originalFetch;
      clearTimeout(timeoutId);
    }
    
    // Store original fetch
    const originalFetch = window.fetch;
    
    // Custom implementation to intercept fetch
    window.fetch = async function(resource, options = {}) {
      const url = resource instanceof Request ? resource.url : resource;
      const fetchMethod = (options.method || (resource instanceof Request ? resource.method : 'GET')).toUpperCase();
      
      // Check if this request matches our criteria
      const isMatch = urlRegex.test(url) && fetchMethod === method.toUpperCase();
      
      // Track the original call timing
      const startTime = Date.now();
      
      if (isMatch) {
        foundRequest = true;
        
        // Log that we found a matching request
        logMessage({
          type: 'request-start',
          url,
          method: fetchMethod,
          timestamp: startTime
        });
        
        // Track request body if available
        let requestBody = null;
        if (options.body) {
          try {
            requestBody = typeof options.body === 'string' 
              ? JSON.parse(options.body) 
              : options.body;
            
            logMessage({
              type: 'request-body',
              body: requestBody,
              timestamp: Date.now()
            });
          } catch (e) {
            requestBody = options.body;
            
            logMessage({
              type: 'request-body',
              body: options.body,
              timestamp: Date.now()
            });
          }
        }
      }
      
      try {
        // Call the original fetch
        const response = await originalFetch.apply(this, arguments);
        
        if (isMatch) {
          // Create a clone to read the body (because response body can only be read once)
          const clonedResponse = response.clone();
          
          // Handle streaming or regular response
          try {
            // For streaming responses like completions API
            const reader = clonedResponse.body.getReader();
            let chunks = [];
            
            // Read the stream
            const processStream = async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  
                  if (done) {
                    // Stream is complete
                    break;
                  }
                  
                  // Convert the chunk to text
                  const chunk = new TextDecoder().decode(value);
                  chunks.push(chunk);
                  
                  // Try to parse JSON chunks (for streaming APIs)
                  try {
                    const jsonData = parseStreamingJSON(chunk);
                    logMessage({
                      type: 'response-chunk',
                      chunk: jsonData,
                      timestamp: Date.now()
                    });
                  } catch (e) {
                    // Not a valid JSON, just send the raw chunk
                    logMessage({
                      type: 'response-chunk',
                      chunk: chunk,
                      timestamp: Date.now()
                    });
                  }
                }
                
                // Concatenate all chunks
                const fullBody = chunks.join('');
                
                // Try to parse the complete response
                try {
                  const jsonResponse = JSON.parse(fullBody);
                  const completeMsg = {
                    type: 'response-complete',
                    status: response.status,
                    headers: Object.fromEntries([...response.headers.entries()]),
                    body: jsonResponse,
                    duration: Date.now() - startTime,
                    timestamp: Date.now()
                  };
                  
                  logMessage(completeMsg);
                  
                  // Resolve the promise with the final data and message log
                  cleanupMonitoring();
                  resolve({
                    success: true,
                    status: response.status,
                    headers: Object.fromEntries([...response.headers.entries()]),
                    body: jsonResponse,
                    duration: Date.now() - startTime,
                    messageLog: messageLog
                  });
                } catch (e) {
                  // Not JSON, return as text
                  const completeMsg = {
                    type: 'response-complete',
                    status: response.status,
                    headers: Object.fromEntries([...response.headers.entries()]),
                    body: fullBody,
                    duration: Date.now() - startTime,
                    timestamp: Date.now()
                  };
                  
                  logMessage(completeMsg);
                  
                  cleanupMonitoring();
                  resolve({
                    success: true,
                    status: response.status,
                    headers: Object.fromEntries([...response.headers.entries()]),
                    body: fullBody,
                    duration: Date.now() - startTime,
                    messageLog: messageLog
                  });
                }
              } catch (streamError) {
                logMessage({
                  type: 'error',
                  error: streamError.message,
                  timestamp: Date.now()
                });
                
                cleanupMonitoring();
                reject({
                  error: streamError.message,
                  messageLog: messageLog
                });
              }
            };
            
            // Start processing the stream
            processStream();
          } catch (streamSetupError) {
            // Fallback to regular response handling if streaming fails
            handleRegularResponse(clonedResponse, startTime);
          }
        }
        
        // Return the original response so the application works normally
        return response;
      } catch (error) {
        if (isMatch) {
          logMessage({
            type: 'error',
            error: error.message,
            timestamp: Date.now()
          });
          
          cleanupMonitoring();
          reject({
            error: error.message,
            messageLog: messageLog
          });
        }
        throw error; // Re-throw to not interfere with app error handling
      }
    };
    
    // Helper function to handle regular (non-streaming) responses
    async function handleRegularResponse(response, startTime) {
      try {
        let responseData;
        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('application/json')) {
          responseData = await response.json();
        } else {
          responseData = await response.text();
        }
        
        const completeMsg = {
          type: 'response-complete',
          status: response.status,
          headers: Object.fromEntries([...response.headers.entries()]),
          body: responseData,
          duration: Date.now() - startTime,
          timestamp: Date.now()
        };
        
        logMessage(completeMsg);
        
        cleanupMonitoring();
        resolve({
          success: true,
          status: response.status,
          headers: Object.fromEntries([...response.headers.entries()]),
          body: responseData,
          duration: Date.now() - startTime,
          messageLog: messageLog
        });
      } catch (error) {
        logMessage({
          type: 'error',
          error: error.message,
          timestamp: Date.now()
        });
        
        cleanupMonitoring();
        reject({
          error: error.message,
          messageLog: messageLog
        });
      }
    }
    
    // If we're not waiting for a call and none are in progress, resolve immediately
    if (!waitForCall && !foundRequest) {
      cleanupMonitoring();
      resolve({
        success: false,
        reason: 'No matching API calls in progress and waitForCall is false',
        messageLog: messageLog
      });
    }
    
    // Log that we've started monitoring
    console.log(\`Monitoring for \${method} \${urlPattern} API calls...\`);
  });
}
  function typeString(inputElement, text, hitEnter = false) {
  // Clear existing input value if needed
  inputElement.value = '';
  
  // Type each character with a small delay
  const typeDelay = 50; // milliseconds between keystrokes
  
  const typeCharacter = (index) => {
    if (index >= text.length) {
      // Press Enter when finished typing
      if (hitEnter) inputElement.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      return;
    }
    
    // Get current character
    const char = text[index];
    
    // Dispatch keydown event
    inputElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: char,
      code: \`Key\${char.toUpperCase()}\`,
      keyCode: char.charCodeAt(0),
      which: char.charCodeAt(0),
      bubbles: true,
      cancelable: true
    }));
    
    // Add character to input value
    inputElement.value += char;
    
    // Dispatch input event
    inputElement.dispatchEvent(new Event('input', {
      bubbles: true,
      cancelable: true
    }));
    
    // Schedule next character
    setTimeout(() => typeCharacter(index + 1), typeDelay);
  };
  
  // Start typing
  typeCharacter(0);
}
console.log('[DOM Inspector Tools] Initialized successfully with improved selector generation and API monitoring');
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

// Endpoint for immediate execution
app.post('/execute', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'No code provided' });
    }

    const result = await executeJS(code);
    res.json({ result });
  } catch (error) {
    console.error('Error executing code:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint for streaming execution
app.post('/execute/stream', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'No code provided' });
    }

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Create a unique message handler for this request
    const messageHandler = (event) => {
      if (event.method === 'Runtime.consoleAPICalled') {
        const msg = event.params.args.map(arg => arg.value || arg.description).join(' ');
        res.write(`data: ${JSON.stringify({ type: 'console', message: msg })}\n\n`);
      } else if (event.method === 'Runtime.executionContextDestroyed') {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      }
    };

    // Add the message handler
    if (activeClient) {
      activeClient.on('Runtime.consoleAPICalled', messageHandler);
      activeClient.on('Runtime.executionContextDestroyed', messageHandler);
    }

    // Execute the code
    const result = await executeJS(code);
    
    // Send the final result
    res.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`);
    res.end();

    // Clean up the message handler
    if (activeClient) {
      activeClient.removeListener('Runtime.consoleAPICalled', messageHandler);
      activeClient.removeListener('Runtime.executionContextDestroyed', messageHandler);
    }
  } catch (error) {
    console.error('Error executing code:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
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