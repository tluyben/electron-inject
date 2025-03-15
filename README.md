# Electron DevTools REPL

This tool provides an interactive REPL (Read-Eval-Print Loop) interface for injecting JavaScript into running Electron applications via Chrome DevTools Protocol (CDP). It allows you to experiment with and modify Electron apps without needing to unpack or repackage them.

## Features

- Connect to any Electron app running with DevTools debugging enabled
- Execute JavaScript directly in the Electron app's context
- Interactive REPL with command history (up/down arrows)
- Option to run a script file directly
- REST API for programmatic access
- Command history navigation
- Special commands for loading files, clearing console, etc.

## Installation

1. Clone or download this repository
2. Install dependencies:

```bash
npm install
```

## Usage

### Starting an Electron app with debugging enabled

First, start your target Electron app with remote debugging enabled:

```bash
/path/to/electron-app --remote-debugging-port=9222
```

### Running the REPL

Basic usage:

```bash
node server.js
```

With custom debugging port:

```bash
node server.js --port 9333
```

Execute a script file and then start REPL:

```bash
node server.js --script ./my-script.js
```

### Command-line options

- `--port`, `-p`: DevTools debugging port to connect to (default: 9222)
- `--script`, `-s`: JavaScript file to execute in the Electron app
- `--server-port`, `-sp`: Port for the Express server (default: 3000)
- `--help`, `-h`: Show help

### REPL special commands

When in the REPL:

- `.exit`: Exit the REPL
- `.clear`: Clear the console
- `.load <file>`: Load and execute a JavaScript file
- `.help`: Show help message

### HTTP API

The server also provides a simple REST API:

**Execute JavaScript:**
```
POST /execute
Content-Type: application/json

{
  "code": "document.title = 'New Title'; return document.title;"
}
```

## Examples

### Basic DOM manipulation

```javascript
// Change the background color of the page
document.body.style.backgroundColor = 'lightblue';
```

### Get application information

```javascript
// Return Electron and Node.js version information
process.versions
```

### Add custom UI elements

```javascript
// Add a floating button
const btn = document.createElement('button');
btn.textContent = 'Custom Button';
btn.style.position = 'fixed';
btn.style.bottom = '20px';
btn.style.right = '20px';
btn.style.zIndex = '9999';
btn.onclick = () => alert('Button clicked!');
document.body.appendChild(btn);
```

## Troubleshooting

1. **Cannot connect to the Electron app**:
   - Ensure the app is running with the `--remote-debugging-port` flag
   - Check if the port number matches between the app and this tool
   - Some Electron apps may explicitly disable remote debugging

2. **JavaScript execution fails**:
   - Check the app's Content Security Policy (CSP), which might block script execution
   - The app might be using contextIsolation or other security features

## License

MIT