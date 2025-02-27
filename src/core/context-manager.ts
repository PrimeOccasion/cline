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
type SummarizationStrategy = "light" | "standard" | "aggressive"

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
        this.summaryPrompt = "You are an expert assistant tasked with summarizing previous conversation context. Create a detailed summary that preserves all critical information including: 1) Key decisions and their rationale, 2) Critical code snippets and file paths, 3) Important problem-solving approaches, 4) Unresolved issues, and 5) Actions taken. This summary will be used to maintain context in an ongoing technical conversation."
        this.summarizationThreshold = 0.5 // 50% context usage triggers summarization
    }

    /**
     * Estimates token count for a message more accurately than character count
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
                    // Tool use blocks have overhead + parameter lengths
                    const paramLength = JSON.stringify(block.input || {}).length / 4
                    return sum + 20 + paramLength // Base overhead + param estimation
                } else if (block.type === "tool_result") {
                    // Estimate based on result content length
                    const resultLength = typeof block.content === 'string' 
                        ? block.content.length 
                        : JSON.stringify(block.content).length
                    return sum + 10 + (resultLength / 4) // Base overhead + content estimation
                }
                return sum + 10 // Default for unknown block types
            }, 0)
        } else if (typeof message.content === 'string') {
            // Simple estimation for string content
            tokenCount = message.content.length / 4
        }
        
        // Add role overhead
        tokenCount += 4
        
        return Math.ceil(tokenCount)
    }

    /**
     * Analyzes conversation to determine if summarization is needed
     */
    public analyzeConversation(messages: Anthropic.MessageParam[]): ContextAnalysis {
        let totalTokens = 0
        
        // Calculate token usage for all messages
        messages.forEach(message => {
            totalTokens += this.estimateTokenCount(message)
        })
        
        return {
            totalTokens,
            utilizationPercentage: totalTokens / this.maxContextLength,
            needsSummarization: totalTokens >= this.maxContextLength * this.summarizationThreshold,
            messageCount: messages.length
        }
    }

    /**
     * Formats messages for summarization in an efficient way
     */
    private formatMessagesForSummary(messages: Anthropic.MessageParam[]): string {
        return messages
            .map(msg => {
                const role = msg.role.toUpperCase()
                const content = Array.isArray(msg.content)
                    ? msg.content
                        .map(block => {
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
            // Format the conversation to be summarized
            const conversationText = this.formatMessagesForSummary(messagesToSummarize)
            
            // Create the API request stream
            const stream = api.createMessage(this.summaryPrompt, [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Please summarize the following conversation, focusing on preserving all technical details, decisions, code changes, and progress:\n\n${conversationText}`
                        }
                    ]
                }
            ])
            
            // Collect summary from stream
            let summary = ""
            for await (const chunk of stream) {
                if (chunk.type === "text") {
                    summary += chunk.text
                }
            }
            
            // Add clear header to summary
            return "## CONTEXT SUMMARY\n\n" + summary
        } catch (error) {
            console.error("Failed to create context summary:", error)
            return "## CONTEXT SUMMARY\n\nPrevious conversation included technical discussions and code edits that have been summarized due to context limitations."
        }
    }

    /**
     * Determines the optimal summarization strategy based on context utilization
     */
    private getSummarizationStrategy(utilization: number): SummarizationStrategy {
        if (utilization > 0.8) return "aggressive" // Keep only 20%
        if (utilization > 0.6) return "standard"   // Keep about 40%
        return "light"                            // Keep about 60%
    }

    /**
     * Get the range of messages to summarize based on strategy
     */
    private getMessageRange(
        messages: Anthropic.MessageParam[], 
        deletedRange: [number, number] | undefined, 
        strategy: SummarizationStrategy
    ): [number, number] {
        const totalMessages = messages.length
        // Always keep the first (task) message
        const start = 1
        let end: number
        
        switch (strategy) {
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
        
        // Adjust for previously deleted ranges to avoid gaps
        if (deletedRange) {
            end = Math.min(end, deletedRange[0] - 1)
        }
        
        return [start, end]
    }

    /**
     * Optimizes conversation history with intelligent summarization
     * Direct replacement for the current summarization logic in Cline
     */
    public async optimizeConversationHistory(
        api: ApiHandler,
        history: Anthropic.MessageParam[],
        deletedRange: [number, number] | undefined
    ): Promise<OptimizationResult> {
        const analysis = this.analyzeConversation(history)
        
        // If summarization not needed, return original history
        if (!analysis.needsSummarization) {
            return {
                history,
                deletedRange,
                didSummarize: false
            }
        }
        
        // Determine strategy and message range to summarize
        const strategy = this.getSummarizationStrategy(analysis.utilizationPercentage)
        const [start, end] = this.getMessageRange(history, deletedRange, strategy)
        
        // Generate summary of messages to be replaced
        const messagesToSummarize = history.slice(start, end + 1)
        if (messagesToSummarize.length === 0) {
            return {
                history,
                deletedRange,
                didSummarize: false
            }
        }
        
        const summary = await this.createSummary(api, messagesToSummarize)
        
        // Create new history with summary
        const taskMessage = history[0]
        const summaryMessage: Anthropic.MessageParam = {
            role: "assistant",
            content: [{ type: "text", text: summary }]
        }
        const recentMessages = history.slice(end + 1)
        
        const newHistory = [taskMessage, summaryMessage, ...recentMessages]
        const newDeletedRange = deletedRange ? 
            [Math.min(start, deletedRange[0]), Math.max(end, deletedRange[1])] as [number, number] : 
            [start, end] as [number, number]
        
        return {
            history: newHistory,
            deletedRange: newDeletedRange,
            didSummarize: true,
            messagesReplaced: messagesToSummarize.length
        }
    }
}