function combineResponseChunks(result) {
    let responseText = "";

    result.forEach(item => {
        if (item.type === "response-chunk") {
            item.chunk.forEach(chunkItem => {
                try {
                    const data = JSON.parse(chunkItem.split("data: ")[1]);
                    if (data.type === "content_block_delta" && data.delta.type === "text_delta") {
                        responseText += data.delta.text;
                    }
                } catch (error) {
                    console.error("Error parsing chunk:", error);
                }
            });
        }
    });

    return responseText.trim();
}

function monitorChat() {
    monitorApiCall(".*\\/completion$", "POST", true, event => {
        // This callback is optional - you'll still get all messages in the final result
        console.log(`Event: ${event.type}`, event);
      })
      .then(result => {
        console.log('Complete API call result:', result);
        console.log('All messages in order:', result.messageLog);
      })
      .catch(error => {
        console.error('Error monitoring API call:', error);
        console.log('Messages collected before error:', error.messageLog);
      });

}