import { app } from "electron"
import Store from "electron-store"
import { log } from "./log"

const config = new Store()

/**
 * Event types that can be sent to OpenHAB
 */
export type OpenHABEventType = "game_started" | "game_ended" | "achievement_unlocked"

/**
 * Payload structure for game events
 */
export interface OpenHABGameEvent {
    event_type: "game_started" | "game_ended"
    appid: number
    gamename: string
    timestamp: string
}

/**
 * Payload structure for achievement events
 */
export interface OpenHABAchievementEvent {
    event_type: "achievement_unlocked"
    appid: number
    gamename: string
    achievement_apiname: string
    achievement_displayname: string
    achievement_description?: string
    timestamp: string
}

export type OpenHABEvent = OpenHABGameEvent | OpenHABAchievementEvent

/**
 * Check if OpenHAB integration is enabled
 */
export function isOpenHABEnabled(): boolean {
    const enabled = config.get("openhab_enabled")
    return typeof enabled === "boolean" ? enabled : false
}

/**
 * Get the configured OpenHAB REST API URL
 */
export function getOpenHABUrl(): string | null {
    const url = config.get("openhab_url")
    if (typeof url === "string" && url.trim().length > 0) {
        return url.trim()
    }
    return null
}

/**
 * Check if popup notifications should be suppressed
 */
export function shouldDisablePopups(): boolean {
    const disabled = config.get("openhab_disable_popups")
    return typeof disabled === "boolean" ? disabled : false
}

/**
 * Get item name for event type
 */
function getItemName(eventType: OpenHABEventType): string | null {
    const itemName = config.get(`openhab_item_${eventType}`)
    return typeof itemName === "string" && itemName.trim().length > 0 ? itemName.trim() : null
}

/**
 * Send an event to OpenHAB REST API
 * Sends simple text values to individual OpenHAB items
 * 
 * @param eventType - Type of event to send
 * @param payload - Event data
 * @returns Promise that resolves when the request completes
 */
export async function sendOpenHABEvent(
    eventType: OpenHABEventType,
    payload: Partial<OpenHABEvent>
): Promise<void> {
    // Check if OpenHAB integration is enabled
    if (!isOpenHABEnabled()) {
        log.write("INFO", "OpenHAB integration is disabled, skipping event")
        return
    }

    // Get OpenHAB base URL from config
    const baseUrl = getOpenHABUrl()
    if (!baseUrl) {
        log.write("ERROR", "OpenHAB base URL not configured, cannot send event")
        return
    }

    // Get item name for this event type
    const itemName = getItemName(eventType)
    if (!itemName) {
        log.write("ERROR", `OpenHAB item name not configured for ${eventType}`)
        return
    }

    // Determine simple value to send
    let simpleValue: string
    if (eventType === "game_started" || eventType === "game_ended") {
        // Send appid as string
        simpleValue = payload.appid?.toString() || "0"
    } else {
        // achievement_unlocked: send apiname
        simpleValue = (payload as Partial<OpenHABAchievementEvent>).achievement_apiname || "unknown"
    }

    const itemUrl = `${baseUrl}/rest/items/${itemName}`
    
    try {
        log.write("INFO", `Sending OpenHAB event: ${eventType} -> ${itemName} = ${simpleValue}`)

        const response = await fetch(itemUrl, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
                "User-Agent": `Steam Achievement Notifier/${app.getVersion()}`
            },
            body: simpleValue
        })

        if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error")
            log.write("ERROR", `OpenHAB request failed: ${response.status} ${response.statusText} - ${errorText}`)
            return
        }

        log.write("INFO", `OpenHAB event sent successfully: ${itemName} = ${simpleValue}`)
    } catch (error) {
        log.write("ERROR", `Failed to send OpenHAB event: ${error instanceof Error ? error.message : String(error)}`)
    }
}

/**
 * Send a game_started event to OpenHAB
 */
export async function sendGameStarted(appid: number, gamename: string): Promise<void> {
    await sendOpenHABEvent("game_started", {
        appid,
        gamename
    })
}

/**
 * Send a game_ended event to OpenHAB
 */
export async function sendGameEnded(appid: number, gamename: string): Promise<void> {
    await sendOpenHABEvent("game_ended", {
        appid,
        gamename
    })
}

/**
 * Send an achievement_unlocked event to OpenHAB
 */
export async function sendAchievementUnlocked(
    appid: number,
    gamename: string,
    achievementApiName: string,
    displayName: string,
    description?: string
): Promise<void> {
    await sendOpenHABEvent("achievement_unlocked", {
        appid,
        gamename,
        achievement_apiname: achievementApiName,
        achievement_displayname: displayName,
        achievement_description: description
    })
}
