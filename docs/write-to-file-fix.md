# Write-to-File Tool Fix

## Overview

This document describes a fix for an issue in Cline that was preventing the `write_to_file` tool from handling files with more than approximately 30 lines of content. The problem was in the message parsing system, specifically in how it handled the content parameter for the `write_to_file` tool.

## The Problem

The original implementation in `parseAssistantMessage.ts` had a special case for the `write_to_file` tool that only triggered when the accumulator ended with the closing tag `</content>`. This approach had a critical limitation:

```typescript
// special case for write_to_file where file contents could contain the closing tag
if (currentToolUse.name === "write_to_file" && accumulator.endsWith(`</${contentParamName}>`)) {
    // ... extract content ...
}
```

The issue was that this code only handled the case where the closing tag was at the very end of the accumulated content. When processing large file contents, the parser would often encounter patterns that looked like XML tags within the content, causing it to prematurely close the parameter or fail to properly extract the full content.

## The Solution

The fix adds special handling for the `write_to_file` tool's content parameter during the parameter accumulation phase:

```typescript
// Special handling for write_to_file content parameter
if (currentToolUse.name === "write_to_file" && currentParamName === "content") {
    // Check if the current parameter value contains the closing tag
    const closingTagIndex = currentParamValue.lastIndexOf(paramClosingTag)
    if (closingTagIndex !== -1) {
        // Extract content up to the closing tag
        currentToolUse.params[currentParamName] = currentParamValue.slice(0, closingTagIndex).trim()
        currentParamName = undefined
        continue
    }
    // If no closing tag found, continue accumulating
    continue
}
```

This improved implementation:

1. Specifically targets the `content` parameter of the `write_to_file` tool
2. Checks for the closing tag anywhere in the parameter value, not just at the end
3. Extracts the content up to the closing tag as soon as it's found
4. Keeps the original special case handling as a fallback with an updated comment

## Benefits

This fix enables Cline to:

- Handle files of any reasonable size without parsing issues
- Properly extract content that might contain XML-like tags
- Maintain backward compatibility with existing code
- Avoid the need for more complex chunking mechanisms

## Implementation Details

The fix was implemented in `src/core/assistant-message/parse-assistant-message.ts` and required minimal changes to the existing codebase. The solution is focused specifically on the issue without introducing unnecessary complexity.

## Current System Prompt Structure

Cline's system prompt is structured to provide clear instructions on tool usage and critical rules. The prompt includes:

1. **Introduction**: Establishes Cline's identity as a software engineer
2. **Tool Use**: Defines available tools with XML-style syntax examples
3. **Critical Rules**: Lists important guidelines for tool usage and behavior
4. **System Info**: Provides details about the operating environment
5. **Editing Files**: Gives specific instructions for file operations
6. **Modes**: Explains Plan Mode and Act Mode functionality
7. **Objective**: Outlines the approach to completing user tasks

The prompt is designed to be concise while providing all necessary information for Cline to function effectively. It dynamically includes sections based on available capabilities (e.g., browser support, MCP servers) and incorporates user-provided custom instructions when available.

## Testing

The fix has been tested with large files and complex content, confirming that Cline can now handle files with hundreds of lines without issues. The implementation maintains compatibility with all other tools and parameters.
