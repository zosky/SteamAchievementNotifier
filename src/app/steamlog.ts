import fs from "fs"
import path from "path"
import { log } from "./log"
import { sanconfig } from "./config"
import { sanhelper } from "./sanhelper"

export interface SteamLogEvent {
    type: "added" | "removed"
    appid: number
    exename: string
    procid: number
}

/**
 * Get Steam console log path for current platform
 */
export const getSteamLogPath = (): string | null => {
    const config = sanconfig.get()
    
    // Allow user override
    const customPath = config.get("steamlogpath") as string
    if (customPath && fs.existsSync(customPath)) {
        log.write("INFO", `Using custom Steam log path: ${customPath}`)
        return customPath
    }

    // Platform-specific default paths
    if (process.platform === "linux") {
        const home = process.env.HOME || ""
        const logPath = path.join(home, ".steam", "steam", "logs", "console_log.txt")
        if (fs.existsSync(logPath)) {
            log.write("INFO", `Found Steam log at: ${logPath}`)
            return logPath
        }
        // Try alternate location
        const altPath = path.join(home, ".local", "share", "Steam", "logs", "console_log.txt")
        if (fs.existsSync(altPath)) {
            log.write("INFO", `Found Steam log at: ${altPath}`)
            return altPath
        }
    } else if (process.platform === "win32") {
        const steamPath = sanhelper.steampath
        if (!steamPath) {
            log.write("WARN", "Steam path not found")
            return null
        }
        const logPath = path.join(steamPath, "logs", "console_log.txt")
        if (fs.existsSync(logPath)) {
            log.write("INFO", `Found Steam log at: ${logPath}`)
            return logPath
        }
    } else if (process.platform === "darwin") {
        const home = process.env.HOME || ""
        const logPath = path.join(home, "Library", "Application Support", "Steam", "logs", "console_log.txt")
        if (fs.existsSync(logPath)) {
            log.write("INFO", `Found Steam log at: ${logPath}`)
            return logPath
        }
    }

    log.write("WARN", "Steam console log file not found")
    return null
}

/**
 * Parse Steam console log line for game events
 */
const parseLogLine = (line: string): SteamLogEvent | null => {
    // Game process added : AppID 12345 "GameName.exe", ProcID 67890, IP 0.0.0.0:0
    const addedMatch = line.match(/Game process added\s*:\s*AppID\s+(\d+)\s+"([^"]+)",\s*ProcID\s+(\d+)/)
    if (addedMatch) {
        return {
            type: "added",
            appid: parseInt(addedMatch[1]),
            exename: addedMatch[2],
            procid: parseInt(addedMatch[3])
        }
    }

    // Game process removed: AppID 12345 "GameName.exe", ProcID 67890
    const removedMatch = line.match(/Game process removed:\s*AppID\s+(\d+)\s+"([^"]+)",\s*ProcID\s+(\d+)/)
    if (removedMatch) {
        return {
            type: "removed",
            appid: parseInt(removedMatch[1]),
            exename: removedMatch[2],
            procid: parseInt(removedMatch[3])
        }
    }

    return null
}

/**
 * Watch Steam log file for game events
 * Handles log rotation by detecting file changes
 */
export class SteamLogWatcher {
    private logPath: string | null = null
    private watcher: fs.FSWatcher | null = null
    private lastPosition: number = 0
    private buffer: string = ""
    private active: boolean = false
    private onEventCallback: ((event: SteamLogEvent) => void) | null = null
    private rotationWatcher: fs.FSWatcher | null = null

    constructor() {
        this.logPath = getSteamLogPath()
        
        if (!this.logPath) {
            log.write("WARN", "Steam console log file not found - log monitoring unavailable")
        }
    }

    /**
     * Start watching the log file
     */
    start(onEvent: (event: SteamLogEvent) => void): boolean {
        if (!this.logPath) {
            log.write("WARN", "Cannot start log watcher - log path not available")
            return false
        }

        if (this.active) {
            log.write("WARN", "Log watcher already active")
            return true
        }

        this.onEventCallback = onEvent
        this.active = true

        try {
            // Get current file size and seek to end (only monitor new events)
            const stats = fs.statSync(this.logPath)
            this.lastPosition = stats.size
            
            log.write("INFO", `Starting Steam log watcher at position ${this.lastPosition}`)

            // Watch for file changes (new content)
            this.watcher = fs.watch(this.logPath, (eventType) => {
                if (eventType === "change") {
                    this.readNewContent()
                } else if (eventType === "rename") {
                    log.write("INFO", "Steam log file renamed/rotated - reattaching")
                    this.handleRotation()
                }
            })

            // Watch parent directory for log rotation
            const logDir = path.dirname(this.logPath)
            const logBase = path.basename(this.logPath)
            this.rotationWatcher = fs.watch(logDir, (eventType, filename) => {
                if (filename === logBase && (eventType === "rename" || eventType === "change")) {
                    // Check if file was recreated after rotation
                    if (this.logPath && fs.existsSync(this.logPath)) {
                        const stats = fs.statSync(this.logPath)
                        if (stats.size < this.lastPosition) {
                            log.write("INFO", "Steam log file rotated - resetting position")
                            this.handleRotation()
                        }
                    }
                }
            })

            log.write("INFO", "Steam log watcher started successfully")
            return true
        } catch (err) {
            log.write("ERROR", `Failed to start log watcher: ${(err as Error).message}`)
            this.stop()
            return false
        }
    }

    /**
     * Handle log file rotation
     */
    private handleRotation() {
        this.lastPosition = 0
        this.buffer = ""
        
        // Wait briefly for new file to be created
        setTimeout(() => {
            if (this.logPath && fs.existsSync(this.logPath)) {
                log.write("INFO", "Reattached to rotated log file")
                // Re-read from beginning of new log
                this.readNewContent()
            } else {
                log.write("ERROR", "Log file not found after rotation")
                this.stop()
            }
        }, 500)
    }

    /**
     * Read new content from log file
     */
    private readNewContent() {
        if (!this.logPath) return

        try {
            const stats = fs.statSync(this.logPath)
            const currentSize = stats.size

            // File was truncated or rotated
            if (currentSize < this.lastPosition) {
                log.write("INFO", "Log file truncated/rotated - resetting position")
                this.lastPosition = 0
                this.buffer = ""
            }

            if (currentSize === this.lastPosition) return

            // Read only the new content
            const stream = fs.createReadStream(this.logPath, {
                start: this.lastPosition,
                end: currentSize,
                encoding: "utf8"
            })

            stream.on("data", (chunk: string | Buffer) => {
                this.buffer += chunk.toString()
                this.processBuffer()
            })

            stream.on("end", () => {
                this.lastPosition = currentSize
            })

            stream.on("error", (err) => {
                log.write("ERROR", `Error reading log file: ${err.message}`)
            })
        } catch (err) {
            log.write("ERROR", `Error reading new log content: ${(err as Error).message}`)
        }
    }

    /**
     * Process buffered log content line by line
     */
    private processBuffer() {
        let newlineIndex: number

        while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, newlineIndex)
            this.buffer = this.buffer.slice(newlineIndex + 1)

            const event = parseLogLine(line)
            if (event && this.onEventCallback) {
                log.write("INFO", `Steam log event: ${event.type} AppID ${event.appid} (${event.exename})`)
                this.onEventCallback(event)
            }
        }
    }

    /**
     * Stop watching the log file
     */
    stop() {
        if (this.watcher) {
            this.watcher.close()
            this.watcher = null
        }

        if (this.rotationWatcher) {
            this.rotationWatcher.close()
            this.rotationWatcher = null
        }

        this.active = false
        this.onEventCallback = null
        this.buffer = ""
        this.lastPosition = 0

        log.write("INFO", "Steam log watcher stopped")
    }

    /**
     * Check if watcher is active
     */
    isActive(): boolean {
        return this.active
    }

    /**
     * Get current log path
     */
    getLogPath(): string | null {
        return this.logPath
    }
}

/**
 * Check if log monitoring is available
 */
export const isSteamLogAvailable = (): boolean => {
    return getSteamLogPath() !== null
}
