// src/core/context-manager.ts

import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "../api"

// Interface for context analysis results
interface ContextAnalysis {
	totalTokens: number
	utilizationPercentage: number
	needsSummarization: boolean
	messageCount: number
}

// Interface for optimization results
interface OptimizationResult {
	history: Anthropic.MessageParam[]
	deletedRange: [number, number] | undefined
	didSummarize: boolean
	messagesReplaced?: number
}

// Define summarization strategies
type SummarizationStrategy = "light" | "standard" | "aggressive" | "emergency"

/**
 * Optimized context management for tracking and summarizing conversation
 */
export class ContextManager {
	private model: string
	private maxContextLength: number
	private summaryPrompt: string
	private summarizationThreshold: number

	constructor(model: string, maxContextLength: number) {
		this.model = model
		this.maxContextLength = maxContextLength || 128000 // Default to 128k if not specified
		this.summaryPrompt =
			"You are an expert assistant tasked with summarizing previous conversation context. Create a detailed summary that preserves all critical information including: 1) Key decisions and rationale, 2) Critical code snippets and file paths, 3) Important approaches, 4) Unresolved issues, 5) Actions taken. This summary will be used to maintain context in a technical conversation."
		this.summarizationThreshold = 0.31 // Adjusted from 0.5 to 0.31 to target ~110k tokens
	}

	/**
	 * Estimates token count for a message more accurately than naive character count
	 */
	private estimateTokenCount(message: Anthropic.MessageParam): number {
		let tokenCount = 0

		if (Array.isArray(message.content)) {
			tokenCount = message.content.reduce((sum, block) => {
				if (block.type === "text") {
					// More accurate token estimation for text
					const text = block.text
					const words = text.split(/\s+/).length
					const punctuation = (text.match(/[.,!?;:()[\]{}'"]/g) || []).length
					return sum + words + Math.ceil(punctuation * 0.5)
				} else if (block.type === "tool_use") {
					// Overhead + parameter lengths
					const paramLength = JSON.stringify(block.input || {}).length / 4
					return sum + 20 + paramLength // Base overhead + param
				} else if (block.type === "tool_result") {
					// Estimate based on result content length
					const resultLength =
						typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length
					return sum + 10 + resultLength / 4 // Overhead + content
				}
				return sum + 10 // Default overhead for unknown block
			}, 0)
		} else if (typeof message.content === "string") {
			// Simple text
			tokenCount = message.content.length / 4
		}

		// Add role overhead
		tokenCount += 4

		// Apply correction factor to account for XML tags and other factors
		// that cause the estimation to be lower than actual token usage
		return Math.ceil(tokenCount * 1.8)
	}

	/**
	 * Analyzes conversation to determine if summarization is needed
	 */
	public analyzeConversation(messages: Anthropic.MessageParam[]): ContextAnalysis {
		let totalTokens = 0

		// Calculate token usage for all messages
		messages.forEach((message) => {
			totalTokens += this.estimateTokenCount(message)
		})

		const utilizationPercentage = totalTokens / this.maxContextLength

		// Force summarization at high utilization regardless of threshold
		const needsSummarization =
			utilizationPercentage >= 0.7 || // Force at 70%
			totalTokens >= this.maxContextLength * this.summarizationThreshold

		console.log(
			`[ContextManager] Analysis: ${Math.round(utilizationPercentage * 100)}% used, ${totalTokens}/${this.maxContextLength} tokens`,
		)
		console.log(
			`[ContextManager] Need summarization: ${needsSummarization}, threshold: ${Math.round(this.summarizationThreshold * 100)}%`,
		)

		return {
			totalTokens,
			utilizationPercentage,
			needsSummarization,
			messageCount: messages.length,
		}
	}

	/**
	 * Formats messages for summarization in an efficient way
	 */
	private formatMessagesForSummary(messages: Anthropic.MessageParam[]): string {
		return messages
			.map((msg) => {
				const role = msg.role.toUpperCase()
				const content = Array.isArray(msg.content)
					? msg.content
							.map((block) => {
								if (block.type === "text") return block.text
								if (block.type === "tool_use") return `[Used tool: ${block.name}]`
								if (block.type === "tool_result") return `[Tool result]`
								return ""
							})
							.filter(Boolean)
							.join("\n")
					: msg.content
				return `${role}: ${content}\n\n`
			})
			.join("")
	}

	/**
	 * Creates an optimized summary of conversation messages
	 */
	public async createSummary(api: ApiHandler, messagesToSummarize: Anthropic.MessageParam[]): Promise<string> {
		try {
			// Format conversation to be summarized
			const conversationText = this.formatMessagesForSummary(messagesToSummarize)

			// Create the request stream
			const stream = api.createMessage(this.summaryPrompt, [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `Please summarize the following conversation, focusing on key details, code changes, and progress:\n\n${conversationText}`,
						},
					],
				},
			])

			// Collect summary from stream
			let summary = ""
			for await (const chunk of stream) {
				if (chunk.type === "text") {
					summary += chunk.text
				}
			}

			// Add a clear header
			return "## CONTEXT SUMMARY\n\n" + summary
		} catch (error) {
			console.error("Failed to create context summary:", error)
			return (
				"## CONTEXT SUMMARY\n\n" +
				"Previous conversation included technical discussions and code edits that have been summarized due to context limits."
			)
		}
	}

	/**
	 * Determines the optimal summarization strategy
	 */
	private getSummarizationStrategy(utilization: number): SummarizationStrategy {
		if (utilization > 0.9) return "emergency" // keep only ~10%
		if (utilization > 0.8) return "aggressive" // keep only ~20%
		if (utilization > 0.6) return "standard" // keep ~40%
		return "light" // keep ~60%
	}

	/**
	 * Get the range of messages to summarize based on strategy
	 */
	private getMessageRange(
		messages: Anthropic.MessageParam[],
		deletedRange: [number, number] | undefined,
		strategy: SummarizationStrategy,
	): [number, number] {
		const totalMessages = messages.length
		// Always keep the first (task) message
		const start = 1
		let end: number

		switch (strategy) {
			case "emergency":
				end = Math.floor(totalMessages * 0.9)
				break
			case "aggressive":
				end = Math.floor(totalMessages * 0.8)
				break
			case "standard":
				end = Math.floor(totalMessages * 0.6)
				break
			case "light":
			default:
				end = Math.floor(totalMessages * 0.4)
				break
		}

		// Ensure we have at least some messages to summarize
		if (end <= start) {
			// If we can't summarize due to previous deletions, try to summarize at least 20% of messages after the task
			end = Math.max(start + Math.floor((totalMessages - start) * 0.2), start + 1)
			console.log(`[ContextManager] Adjusted range to ensure summarization: [${start}, ${end}]`)
		}

		// Adjust for previously deleted ranges to avoid re-summarizing
		if (deletedRange) {
			const adjustedEnd = Math.min(end, deletedRange[0] - 1)

			// If adjustment would make range invalid, force summarization of newer content
			if (adjustedEnd <= start) {
				// Find a new range after the deleted range
				const newStart = deletedRange[1] + 1
				const newEnd = Math.min(newStart + Math.floor((totalMessages - newStart) * 0.5), totalMessages - 1)

				// Only use this new range if it's valid
				if (newEnd > newStart && newStart < totalMessages) {
					console.log(`[ContextManager] Using new range after deleted range: [${newStart}, ${newEnd}]`)
					return [newStart, newEnd]
				}

				// If we can't find a valid range after deleted range, use original end
				console.log(`[ContextManager] Using original range despite deleted range: [${start}, ${end}]`)
				return [start, end]
			}

			end = adjustedEnd
		}

		return [start, end]
	}

	/**
	 * Summarize older messages, returning new conversation
	 */
	public async optimizeConversationHistory(
		api: ApiHandler,
		history: Anthropic.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Promise<OptimizationResult> {
		const analysis = this.analyzeConversation(history)
		console.log(
			`[ContextManager] Starting optimization with ${history.length} messages, utilization: ${Math.round(analysis.utilizationPercentage * 100)}%`,
		)

		// If summarization not needed, do nothing
		if (!analysis.needsSummarization) {
			console.log(`[ContextManager] Summarization not needed, skipping`)
			return {
				history,
				deletedRange,
				didSummarize: false,
			}
		}

		// Determine strategy and message range
		const strategy = this.getSummarizationStrategy(analysis.utilizationPercentage)
		console.log(`[ContextManager] Using ${strategy} summarization strategy`)

		const [start, end] = this.getMessageRange(history, deletedRange, strategy)
		console.log(`[ContextManager] Message range to summarize: [${start}, ${end}]`)

		// Generate summary of messages to be replaced
		const messagesToSummarize = history.slice(start, end + 1)
		if (messagesToSummarize.length === 0) {
			console.log(`[ContextManager] No messages to summarize, skipping`)
			return {
				history,
				deletedRange,
				didSummarize: false,
			}
		}

		console.log(`[ContextManager] Summarizing ${messagesToSummarize.length} messages`)
		const summary = await this.createSummary(api, messagesToSummarize)

		// Create new history with summary
		const taskMessage = history[0]
		const summaryMessage: Anthropic.MessageParam = {
			role: "assistant",
			content: [{ type: "text", text: summary }],
		}
		const recentMessages = history.slice(end + 1)

		const newHistory = [taskMessage, summaryMessage, ...recentMessages]
		const newDeletedRange = deletedRange
			? ([Math.min(start, deletedRange[0]), Math.max(end, deletedRange[1])] as [number, number])
			: ([start, end] as [number, number])

		console.log(
			`[ContextManager] Summarization complete. New history has ${newHistory.length} messages (reduced from ${history.length})`,
		)

		return {
			history: newHistory,
			deletedRange: newDeletedRange,
			didSummarize: true,
			messagesReplaced: messagesToSummarize.length,
		}
	}
}
