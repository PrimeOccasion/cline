import { AssistantMessageContent, TextContent, ToolUse, ToolParamName, toolParamNames, toolUseNames, ToolUseName } from "."

export function parseAssistantMessage(assistantMessage: string) {
	let contentBlocks: AssistantMessageContent[] = []
	let currentTextContent: TextContent | undefined = undefined
	let currentTextContentStartIndex = 0
	let currentToolUse: ToolUse | undefined = undefined
	let currentToolUseStartIndex = 0
	let currentParamName: ToolParamName | undefined = undefined
	let currentParamValueStartIndex = 0
	let accumulator = ""

	for (let i = 0; i < assistantMessage.length; i++) {
		const char = assistantMessage[i]
		accumulator += char

		// there should not be a param without a tool use
		if (currentToolUse && currentParamName) {
			const currentParamValue = accumulator.slice(currentParamValueStartIndex)
			const paramClosingTag = `</${currentParamName}>`

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

			// Special handling for replace_in_file diff parameter
			if (currentToolUse.name === "replace_in_file" && currentParamName === "diff") {
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

			// Regular parameter handling for other tools/params
			if (currentParamValue.endsWith(paramClosingTag)) {
				// end of param value
				currentToolUse.params[currentParamName] = currentParamValue.slice(0, -paramClosingTag.length).trim()
				currentParamName = undefined
				continue
			} else {
				// partial param value is accumulating
				continue
			}
		}

		// no currentParamName

		if (currentToolUse) {
			const currentToolValue = accumulator.slice(currentToolUseStartIndex)
			const toolUseClosingTag = `</${currentToolUse.name}>`
			if (currentToolValue.endsWith(toolUseClosingTag)) {
				// end of a tool use
				currentToolUse.partial = false
				contentBlocks.push(currentToolUse)
				currentToolUse = undefined
				continue
			} else {
				const possibleParamOpeningTags = toolParamNames.map((name) => `<${name}>`)
				for (const paramOpeningTag of possibleParamOpeningTags) {
					if (accumulator.endsWith(paramOpeningTag)) {
						// start of a new parameter
						currentParamName = paramOpeningTag.slice(1, -1) as ToolParamName
						currentParamValueStartIndex = accumulator.length
						break
					}
				}

				// there's no current param, and not starting a new param

				// This is a fallback for write_to_file where file contents could contain the closing tag, in which case the param would have closed and we end up with the rest of the file contents here.
				// This should rarely be needed now with the improved handling above, but keeping as a safety net.
				const contentParamName: ToolParamName = "content"
				if (currentToolUse.name === "write_to_file" && accumulator.endsWith(`</${contentParamName}>`)) {
					const toolContent = accumulator.slice(currentToolUseStartIndex)
					const contentStartTag = `<${contentParamName}>`
					const contentEndTag = `</${contentParamName}>`
					const contentStartIndex = toolContent.indexOf(contentStartTag) + contentStartTag.length
					const contentEndIndex = toolContent.lastIndexOf(contentEndTag)
					if (contentStartIndex !== -1 && contentEndIndex !== -1 && contentEndIndex > contentStartIndex) {
						currentToolUse.params[contentParamName] = toolContent.slice(contentStartIndex, contentEndIndex).trim()
					}
				}

				// Similar fallback for replace_in_file diff parameter
				const diffParamName: ToolParamName = "diff"
				if (currentToolUse.name === "replace_in_file" && accumulator.endsWith(`</${diffParamName}>`)) {
					const toolContent = accumulator.slice(currentToolUseStartIndex)
					const diffStartTag = `<${diffParamName}>`
					const diffEndTag = `</${diffParamName}>`
					const diffStartIndex = toolContent.indexOf(diffStartTag) + diffStartTag.length
					const diffEndIndex = toolContent.lastIndexOf(diffEndTag)
					if (diffStartIndex !== -1 && diffEndIndex !== -1 && diffEndIndex > diffStartIndex) {
						currentToolUse.params[diffParamName] = toolContent.slice(diffStartIndex, diffEndIndex).trim()
					}
				}

				// partial tool value is accumulating
				continue
			}
		}

		// no currentToolUse

		let didStartToolUse = false
		const possibleToolUseOpeningTags = toolUseNames.map((name) => `<${name}>`)
		for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
			if (accumulator.endsWith(toolUseOpeningTag)) {
				// start of a new tool use
				currentToolUse = {
					type: "tool_use",
					name: toolUseOpeningTag.slice(1, -1) as ToolUseName,
					params: {},
					partial: true,
				}
				currentToolUseStartIndex = accumulator.length
				// this also indicates the end of the current text content
				if (currentTextContent) {
					currentTextContent.partial = false
					// remove the partially accumulated tool use tag from the end of text (<tool)
					currentTextContent.content = currentTextContent.content
						.slice(0, -toolUseOpeningTag.slice(0, -1).length)
						.trim()
					contentBlocks.push(currentTextContent)
					currentTextContent = undefined
				}

				didStartToolUse = true
				break
			}
		}

		if (!didStartToolUse) {
			// no tool use, so it must be text either at the beginning or between tools
			if (currentTextContent === undefined) {
				currentTextContentStartIndex = i
			}
			currentTextContent = {
				type: "text",
				content: accumulator.slice(currentTextContentStartIndex).trim(),
				partial: true,
			}
		}
	}

	if (currentToolUse) {
		// stream did not complete tool call, add it as partial
		if (currentParamName) {
			// tool call has a parameter that was not completed
			currentToolUse.params[currentParamName] = accumulator.slice(currentParamValueStartIndex).trim()
		}
		contentBlocks.push(currentToolUse)
	}

	// Note: it doesnt matter if check for currentToolUse or currentTextContent, only one of them will be defined since only one can be partial at a time
	if (currentTextContent) {
		// stream did not complete text content, add it as partial
		contentBlocks.push(currentTextContent)
	}

	return contentBlocks
}
