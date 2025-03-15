# Electron App DOM Inspector - Interaction Guide

This guide covers all the ways to interact with and inspect the DOM of an Electron application using the CDP (Chrome DevTools Protocol) connection.

## Getting Started

1. Start the tool by running:
   ```
   node app.js --port 9222
   ```
   Where `9222` is the debugging port of your Electron app.

2. The REPL (Read-Eval-Print Loop) will start automatically, allowing you to type JavaScript commands.

## Basic DOM Inspection

### Finding Elements

```javascript
// Find all elements containing specific text (case-insensitive)
const elements = findElementsByText("search term");
console.log(`Found ${elements.length} elements`);

// Get simplified information (safer than returning full DOM elements)
findElementsByTextInfo("search term");

// Case-sensitive search
findElementsByText("CaseSensitive", true);

// Search within a specific element
const container = document.querySelector(".container");
findElementsByText("search term", false, container);
```

### Highlighting Elements

```javascript
// Find elements then highlight them in red
const elements = findElementsByText("button text");
highlightElements(elements);

// Custom highlight color and duration
highlightElements(elements, 5000, "rgba(0, 255, 0, 0.3)"); // Green highlight for 5 seconds
```

### Detailed Element Inspection

```javascript
// Log detailed information about elements
const elements = findElementsByText("login");
inspectElements(elements);

// This will output:
// - Element reference
// - Text content preview
// - Unique CSS selector
// - All attributes
```

### Getting Unique Selectors

```javascript
// Get a unique selector for an element
const element = document.querySelector(".some-class");
const selector = getUniqueSelector(element);
console.log(selector);
```

## Advanced DOM Querying

### Finding Elements by Style

```javascript
// Find all elements with specific CSS properties
const blueTextElements = findElementsByStyle({
  "color": "rgb(0, 0, 255)"
});

// Find elements with multiple style properties
const importantButtons = findElementsByStyle({
  "background-color": "rgb(255, 0, 0)",
  "font-weight": "700"
});
```

### Finding Clickable Elements

```javascript
// Find all potentially clickable elements
const clickableElements = findClickableElements();
console.log(`Found ${clickableElements.length} clickable elements`);

// Inspect the clickable elements
inspectElements(clickableElements);
```

## DOM Manipulation

Once elements are found, you can manipulate them directly:

```javascript
// Click on an element
const loginButton = findElementsByText("Login")[0];
if (loginButton) loginButton.click();

// Fill a form field
const emailInput = document.querySelector("input[type='email']");
if (emailInput) emailInput.value = "test@example.com";

// Toggle a class
const menuItem = findElementsByText("Settings")[0];
if (menuItem) menuItem.classList.toggle("active");
```

## Event Listeners and Monitoring

```javascript
// Monitor all clicks on the page
document.body.addEventListener("click", (event) => {
  console.log("Element clicked:", event.target);
  console.log("Selector:", getUniqueSelector(event.target));
});

// Monitor form submissions
document.querySelectorAll("form").forEach(form => {
  form.addEventListener("submit", (event) => {
    console.log("Form submitted:", getUniqueSelector(event.target));
    // Prevent actual submission if needed
    // event.preventDefault();
  });
});
```

## Debugging Workflows

### Finding and Interacting with Elements

```javascript
// Example workflow to find and interact with a search box
const searchElements = findElementsByText("search");
inspectElements(searchElements);

// After identifying the correct element from the inspection output
const searchInput = document.querySelector("#search-input"); // Use the selector from inspection
searchInput.value = "search query";
searchInput.dispatchEvent(new Event("input", { bubbles: true }));

// Find and click the search button
const searchButton = findElementsByText("Search")[0];
searchButton.click();
```

### Extracting Content

```javascript
// Extract text from a specific section
const contentSection = document.querySelector(".content-section");
console.log(contentSection.textContent.trim());

// Extract structured data
const tableData = Array.from(document.querySelectorAll("table tr")).map(row => {
  return Array.from(row.querySelectorAll("td, th")).map(cell => cell.textContent.trim());
});
console.log(tableData);
```

## Working with Iframes

```javascript
// Access an iframe's document
const iframe = document.querySelector("iframe");
const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;

// Find elements within the iframe
const iframeElements = findElementsByText("text in iframe", false, iframeDocument.body);
```

## Handling Shadow DOM

```javascript
// Function to search within shadow DOM
function findInShadowDOM(root, selector) {
  let results = [];
  
  // Check if the root has a shadow root
  if (root.shadowRoot) {
    const found = root.shadowRoot.querySelectorAll(selector);
    results = [...results, ...found];
  }
  
  // Check children
  const children = root.querySelectorAll('*');
  for (const child of children) {
    const foundInChild = findInShadowDOM(child, selector);
    results = [...results, ...foundInChild];
  }
  
  return results;
}

// Usage
const shadowElements = findInShadowDOM(document.body, 'button');
```

## Dealing with Dynamic Content

```javascript
// Monitor DOM changes for dynamic content
const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList' && mutation.addedNodes.length) {
      console.log('New nodes added:', mutation.addedNodes);
      
      // Check if our target element has appeared
      const newButtons = findElementsByText("Accept Cookies");
      if (newButtons.length > 0) {
        console.log('Found dynamic button!');
        newButtons[0].click();
        observer.disconnect(); // Stop observing once found
      }
    }
  }
});

// Start observing
observer.observe(document.body, { 
  childList: true, 
  subtree: true 
});
```

## Performance Considerations

For large pages, consider:

```javascript
// Limit search to a specific container
const mainContent = document.querySelector("main");
const elements = findElementsByText("search term", false, mainContent);

// Process elements in batches
function processInBatches(elements, batchSize = 10) {
  let index = 0;
  
  function processBatch() {
    const batch = elements.slice(index, index + batchSize);
    if (batch.length === 0) return;
    
    console.log(`Processing batch ${index/batchSize + 1}`);
    // Process each element in the batch
    batch.forEach(element => {
      // Do something with the element
      console.log(getUniqueSelector(element));
    });
    
    index += batchSize;
    
    // Process next batch
    setTimeout(processBatch, 0);
  }
  
  processBatch();
}

// Usage
const allLinks = document.querySelectorAll('a');
processInBatches(Array.from(allLinks));
```

## Special REPL Commands

The REPL supports special commands:

- `.exit` - Exit the REPL
- `.clear` - Clear the console
- `.load <file>` - Load and execute a JavaScript file
- `.help` - Show help message

## Tips for Avoiding Serialization Errors

When working with complex DOM structures:

1. Use `inspectElements()` instead of returning elements directly
2. Return only specific properties instead of entire elements
3. Use `findElementsByTextInfo()` to get serializable information
4. When manipulating elements, do it directly in the browser context then return simple success/failure messages

## Example Debugging Scenarios

### Scenario 1: Finding and Filling a Login Form

```javascript
// Find the login form
const forms = Array.from(document.querySelectorAll('form'));
console.log(`Found ${forms.length} forms`);
inspectElements(forms);

// Find username and password fields
const usernameInput = document.querySelector('input[type="text"], input[type="email"]');
const passwordInput = document.querySelector('input[type="password"]');

// Fill the form
if (usernameInput) usernameInput.value = 'testuser';
if (passwordInput) passwordInput.value = 'password123';

// Find and click the submit button
const submitButton = findElementsByText('Login')[0] || 
                    document.querySelector('button[type="submit"], input[type="submit"]');
if (submitButton) submitButton.click();
```

### Scenario 2: Extracting Data from a Table

```javascript
// Find tables on the page
const tables = document.querySelectorAll('table');
console.log(`Found ${tables.length} tables`);

// Extract data from the first table
const tableData = [];
const rows = tables[0].querySelectorAll('tr');

rows.forEach(row => {
  const rowData = [];
  row.querySelectorAll('td, th').forEach(cell => {
    rowData.push(cell.textContent.trim());
  });
  if (rowData.length > 0) tableData.push(rowData);
});

console.log(JSON.stringify(tableData, null, 2));
```

### Scenario 3: Monitoring Network Activity

```javascript
// Set up monitoring for fetch and XHR
const originalFetch = window.fetch;
window.fetch = function(...args) {
  console.log('Fetch request:', args[0]);
  return originalFetch.apply(this, args);
};

const originalXHR = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(...args) {
  console.log('XHR request:', args[1]);
  return originalXHR.apply(this, args);
};

console.log('Network monitoring active');
```

## Troubleshooting

If you encounter issues:

1. **Object reference chain too long error**: Use simplified data extraction functions
2. **Elements not found**: Check if the content is in an iframe or shadow DOM
3. **Actions not working**: Elements might be disabled or intercepted by event handlers
4. **Page unresponsive**: Ensure you're not causing infinite loops or excessive DOM operations