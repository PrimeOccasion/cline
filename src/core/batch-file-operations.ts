// src/core/batch-file-operations.ts

import fs from "fs/promises"
import path from "path"
import { fileExistsAtPath } from "../utils/fs"

type BufferEncoding =
  | "ascii"
  | "utf8"
  | "utf-8"
  | "utf16le"
  | "ucs2"
  | "ucs-2"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "hex"

type WriteFileOptions =
  | {
      encoding?: BufferEncoding | null
      mode?: number
      flag?: string
    }
  | BufferEncoding
  | null

// Cache entry with timestamp
interface CacheEntry<T> {
  value: T
  timestamp: number
}

interface FileResult {
  path: string
  content: string | null
  error: Error | null
}

interface FileWriteResult {
  path: string
  success: boolean
  error: Error | null
}

/**
 * Manages optimized file operations with caching and batching.
 */
export class BatchFileOperations {
  private cwd: string
  private cache: Map<string, CacheEntry<any>>
  private cacheMaxAge: number
  private cacheHits: number
  private cacheMisses: number

  constructor(cwd: string) {
    this.cwd = cwd
    this.cache = new Map()
    this.cacheMaxAge = 5000 // 5 seconds
    this.cacheHits = 0
    this.cacheMisses = 0
  }

  /**
   * Resolves a relative path to an absolute path
   */
  public resolvePath(relPath: string): string {
    return path.resolve(this.cwd, relPath)
  }

  /**
   * Creates a cache key
   */
  private getCacheKey(absolutePath: string, operation = "read"): string {
    return `${operation}:${absolutePath}`
  }

  /**
   * Gets a value from cache if exists and not expired
   */
  private getCachedValue<T>(key: string): T | null {
    if (!this.cache.has(key)) return null

    const entry = this.cache.get(key) as CacheEntry<T>
    const now = Date.now()
    if (now - entry.timestamp > this.cacheMaxAge) {
      this.cache.delete(key)
      return null
    }

    this.cacheHits++
    return entry.value
  }

  /**
   * Sets a value in the cache
   */
  private setCacheValue<T>(key: string, value: T): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    })
  }

  /**
   * Invalidates cache entries for a path
   */
  public invalidateCache(absolutePath: string): void {
    const readKey = this.getCacheKey(absolutePath, "read")
    const existsKey = this.getCacheKey(absolutePath, "exists")
    this.cache.delete(readKey)
    this.cache.delete(existsKey)
  }

  /**
   * Checks if a file exists with caching
   */
  public async fileExists(relPath: string): Promise<boolean> {
    const absolutePath = this.resolvePath(relPath)
    const cacheKey = this.getCacheKey(absolutePath, "exists")

    const cachedValue = this.getCachedValue<boolean>(cacheKey)
    if (cachedValue !== null) return cachedValue

    this.cacheMisses++
    try {
      const exists = await fileExistsAtPath(absolutePath)
      this.setCacheValue(cacheKey, exists)
      return exists
    } catch {
      return false
    }
  }

  /**
   * Reads a file with caching
   */
  public async readFile(
    relPath: string,
    options: { encoding: BufferEncoding } = { encoding: "utf8" }
  ): Promise<string> {
    const absolutePath = this.resolvePath(relPath)
    const cacheKey = this.getCacheKey(absolutePath, "read")

    const cachedValue = this.getCachedValue<string>(cacheKey)
    if (cachedValue !== null) return cachedValue

    this.cacheMisses++
    const content = await fs.readFile(absolutePath, { encoding: options.encoding })
    this.setCacheValue(cacheKey, content)
    return content
  }

  /**
   * Writes to a file and invalidates cache
   */
  public async writeFile(
    relPath: string,
    content: string,
    options: BufferEncoding | WriteFileOptions = "utf8"
  ): Promise<string> {
    const absolutePath = this.resolvePath(relPath)

    // Create directories if they don't exist
    const dir = path.dirname(absolutePath)
    await fs.mkdir(dir, { recursive: true })

    await fs.writeFile(absolutePath, content, options)
    this.invalidateCache(absolutePath)
    return absolutePath
  }

  /**
   * Reads multiple files in parallel
   */
  public async readFiles(
    relPaths: string[],
    options: { encoding: BufferEncoding } = { encoding: "utf8" }
  ): Promise<Record<string, FileResult>> {
    const filePromises = relPaths.map(async (relPath) => {
      try {
        const content = await this.readFile(relPath, options)
        return { path: relPath, content, error: null }
      } catch (error) {
        return {
          path: relPath,
          content: null,
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    })

    const results = await Promise.all(filePromises)
    return results.reduce((acc, result) => {
      acc[result.path] = result
      return acc
    }, {} as Record<string, FileResult>)
  }

  /**
   * Writes multiple files in parallel
   */
  public async writeFiles(
    files: { path: string; content: string }[],
    options: BufferEncoding | WriteFileOptions = "utf8"
  ): Promise<FileWriteResult[]> {
    const writePromises = files.map(async ({ path: p, content }) => {
      try {
        await this.writeFile(p, content, options)
        return { path: p, success: true, error: null }
      } catch (error) {
        return {
          path: p,
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    })

    return Promise.all(writePromises)
  }

  /**
   * Returns stats about cache performance
   */
  public getCacheStats(): Record<string, number | string> {
    const totalAccesses = this.cacheHits + this.cacheMisses
    const hitRatio = totalAccesses ? this.cacheHits / totalAccesses : 0

    return {
      size: this.cache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRatio: Number(hitRatio.toFixed(2)),
    }
  }

  /**
   * Clears the entire cache
   */
  public clearCache(): void {
    this.cache.clear()
    this.cacheHits = 0
    this.cacheMisses = 0
  }
}
