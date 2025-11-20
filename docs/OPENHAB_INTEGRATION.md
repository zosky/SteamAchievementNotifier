# OpenHAB Integration Enhancement

## Overview
This enhancement replaces GUI popup notifications with HTTP POST requests to the OpenHAB REST API for three event types:
1. **Game Started** ("Now Tracking" notification)
2. **Game Ended** (when game process closes)
3. **Achievement Unlocked** (when any achievement is unlocked)

## Design Philosophy
Minimize changes to the existing codebase by:
- Creating a new HTTP module similar to existing `webhook.ts`
- Hijacking existing notification trigger points
- Adding configuration options to enable/disable OpenHAB integration
- Keeping the notification system intact for users who want it

---

## Implementation Plan

### 1. Create OpenHAB HTTP Module
**New file:** `src/app/openhab.ts`

This module will handle:
- HTTP POST requests to OpenHAB REST API
- Payload formatting for different event types
- Error handling and logging
- Configuration management

Key functions:
```typescript
export const sendOpenHAB = async (
    eventType: "game_started" | "game_ended" | "achievement_unlocked",
    data: OpenHABEventData
) => Promise<void>
```

**OpenHAB REST API Endpoint Structure:**
```
POST http://<openhab-host>:<port>/rest/items/<item-name>
Content-Type: text/plain

<state-value>
```

Or for more complex data:
```
POST http://<openhab-host>:<port>/rest/events/
Content-Type: application/json

{
  "type": "ItemCommandEvent",
  "topic": "openhab/items/<item-name>/command",
  "payload": "{\"type\":\"String\",\"value\":\"<value>\"}"
}
```

### 2. Configuration Options
Add to `electron-store` config schema:

```typescript
openhab: {
    enabled: boolean,              // Master enable/disable switch
    baseUrl: string,               // e.g., "http://192.168.1.100:8080"
    auth: {
        username?: string,         // Optional basic auth
        password?: string
    },
    events: {
        gameStarted: {
            enabled: boolean,
            itemName: string,      // OpenHAB item name, e.g., "SAN_GameStarted"
            sendPayload: boolean   // Send full JSON payload vs simple state
        },
        gameEnded: {
            enabled: boolean,
            itemName: string,      // e.g., "SAN_GameEnded"
            sendPayload: boolean
        },
        achievementUnlocked: {
            enabled: boolean,
            itemName: string,      // e.g., "SAN_Achievement"
            sendPayload: boolean
        }
    },
    disableNotifications: boolean  // When true, suppress GUI popups entirely
}
```

### 3. Integration Points

#### 3.1 Game Started Event
**Location:** `src/app/listeners.ts`, line ~382
**Trigger:** `ipcMain.on("showtrack", ...)`

**Current behavior:**
- Creates a BrowserWindow with "Now Tracking" notification
- Shows game name and tracking status

**New behavior:**
```typescript
ipcMain.on("showtrack", (event, gamename: string, ra?: { icon: string, gameartlibhero: string }) => {
    const config = sanconfig.get()
    
    // NEW: Send to OpenHAB if enabled
    if (config.get("openhab.enabled") && config.get("openhab.events.gameStarted.enabled")) {
        sendOpenHAB("game_started", {
            gamename,
            timestamp: new Date().toISOString(),
            appid: appid, // Global variable from listeners.ts
            ra: ra ? true : false
        })
    }
    
    // EXISTING: Skip notification if OpenHAB is replacing notifications
    if (config.get("openhab.disableNotifications")) return
    
    // ... existing notification code ...
})
```

#### 3.2 Game Ended Event
**Location:** `src/app/worker.ts`, line ~220
**Trigger:** When game process terminates (inside `gameloop()`)

**Current behavior:**
- Clears interval timer
- Logs "Game loop stopped"
- No notification shown

**New behavior:**
```typescript
const gameloop = () => {
    if (processes.every(({ pid }: ProcessInfo) => pid !== -1 && !isprocessrunning(pid))) {
        clearInterval(timer!)
        log.write("INFO","Game loop stopped")
        
        // NEW: Send to OpenHAB if enabled
        const config = sanconfig.get()
        if (config.get("openhab.enabled") && config.get("openhab.events.gameEnded.enabled")) {
            ipcRenderer.send("openhabGameEnded", {
                gamename: gamename || "???",
                appid,
                timestamp: new Date().toISOString(),
                steam3id
            })
        }
        
        // ... existing cleanup code ...
    }
}
```

**Corresponding listener in `listeners.ts`:**
```typescript
ipcMain.on("openhabGameEnded", (event, data: OpenHABGameEndedData) => {
    sendOpenHAB("game_ended", data)
})
```

#### 3.3 Achievement Unlocked Event
**Location:** `src/app/worker.ts`, line ~318
**Trigger:** When achievement unlock is detected in `unlocked.forEach()`

**Current behavior:**
- Sends `notify` and `sendwebhook` IPC events
- Creates notification with achievement details

**New behavior:**
```typescript
unlocked.forEach(async (achievement: Achievement) => {
    log.write("INFO", `Achievement unlocked: ${JSON.stringify(achievement)}`)
    
    const config = sanconfig.get()
    // ... existing achievement processing code ...
    
    const notify: Notify = {
        // ... existing notify object creation ...
    }
    
    // NEW: Send to OpenHAB if enabled
    if (config.get("openhab.enabled") && config.get("openhab.events.achievementUnlocked.enabled")) {
        ipcRenderer.send("openhabAchievement", {
            gamename: gamename || "???",
            appid,
            steam3id,
            achievement: {
                apiname: achievement.apiname,
                name: notify.name,
                desc: notify.desc,
                percent: achievement.percent,
                hidden: achievement.hidden,
                rarity: type, // "main", "rare", or "plat"
                unlocktime: notify.unlocktime
            }
        })
    }
    
    // EXISTING: Skip notification if OpenHAB is replacing notifications
    if (!config.get("openhab.disableNotifications")) {
        ;["notify","sendwebhook"].forEach(cmd => ipcRenderer.send(cmd, notify, undefined, themeswitch?.[1].src))
    }
    
    // ... rest of existing code ...
})
```

**Corresponding listener in `listeners.ts`:**
```typescript
ipcMain.on("openhabAchievement", (event, data: OpenHABAchievementData) => {
    sendOpenHAB("achievement_unlocked", data)
})
```

---

## Implementation Files

### File 1: `src/app/openhab.ts` (NEW)
```typescript
import { log } from "./log"
import { sanconfig } from "./config"

interface OpenHABConfig {
    enabled: boolean
    baseUrl: string
    auth?: {
        username?: string
        password?: string
    }
    events: {
        gameStarted: EventConfig
        gameEnded: EventConfig
        achievementUnlocked: EventConfig
    }
    disableNotifications: boolean
}

interface EventConfig {
    enabled: boolean
    itemName: string
    sendPayload: boolean
}

export interface OpenHABEventData {
    gamename: string
    appid?: number
    steam3id?: number
    timestamp: string
    achievement?: {
        apiname: string
        name: string
        desc: string
        percent: number
        hidden: boolean
        rarity: string
        unlocktime: string
    }
    ra?: boolean
}

/**
 * Send event data to OpenHAB REST API
 * @param eventType - Type of event: game_started, game_ended, or achievement_unlocked
 * @param data - Event data to send
 */
export const sendOpenHAB = async (
    eventType: "game_started" | "game_ended" | "achievement_unlocked",
    data: OpenHABEventData
): Promise<void> => {
    const config = sanconfig.get()
    const openhabConfig: OpenHABConfig = config.get("openhab") as OpenHABConfig

    if (!openhabConfig.enabled) {
        return log.write("INFO", `OpenHAB integration disabled - skipping ${eventType}`)
    }

    const eventMap = {
        game_started: openhabConfig.events.gameStarted,
        game_ended: openhabConfig.events.gameEnded,
        achievement_unlocked: openhabConfig.events.achievementUnlocked
    }

    const eventConfig = eventMap[eventType]

    if (!eventConfig.enabled) {
        return log.write("INFO", `OpenHAB event "${eventType}" disabled - skipping`)
    }

    if (!openhabConfig.baseUrl) {
        return log.write("ERROR", "OpenHAB baseUrl not configured")
    }

    if (!eventConfig.itemName) {
        return log.write("ERROR", `OpenHAB itemName not configured for ${eventType}`)
    }

    try {
        const url = eventConfig.sendPayload
            ? `${openhabConfig.baseUrl}/rest/events/`
            : `${openhabConfig.baseUrl}/rest/items/${eventConfig.itemName}`

        const headers: HeadersInit = {
            "Content-Type": eventConfig.sendPayload ? "application/json" : "text/plain"
        }

        // Add basic auth if configured
        if (openhabConfig.auth?.username && openhabConfig.auth?.password) {
            const auth = Buffer.from(
                `${openhabConfig.auth.username}:${openhabConfig.auth.password}`
            ).toString("base64")
            headers["Authorization"] = `Basic ${auth}`
        }

        let body: string

        if (eventConfig.sendPayload) {
            // Send full JSON payload as ItemCommandEvent
            const payload = {
                type: "ItemCommandEvent",
                topic: `openhab/items/${eventConfig.itemName}/command`,
                payload: JSON.stringify({
                    type: "String",
                    value: JSON.stringify({
                        eventType,
                        ...data
                    })
                })
            }
            body = JSON.stringify(payload)
        } else {
            // Send simple state value
            body = eventType === "achievement_unlocked"
                ? data.achievement?.name || "Achievement Unlocked"
                : data.gamename
        }

        const response = await fetch(url, {
            method: "POST",
            headers,
            body
        })

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        log.write("INFO", `OpenHAB ${eventType} sent successfully: ${eventConfig.itemName}`)
    } catch (err) {
        log.write("ERROR", `Error sending OpenHAB ${eventType}: ${(err as Error).message}`)
    }
}

/**
 * Test OpenHAB connection
 * @returns Promise<boolean> - True if connection successful
 */
export const testOpenHABConnection = async (): Promise<boolean> => {
    const config = sanconfig.get()
    const openhabConfig: OpenHABConfig = config.get("openhab") as OpenHABConfig

    if (!openhabConfig.baseUrl) {
        log.write("ERROR", "OpenHAB baseUrl not configured")
        return false
    }

    try {
        const headers: HeadersInit = {}

        if (openhabConfig.auth?.username && openhabConfig.auth?.password) {
            const auth = Buffer.from(
                `${openhabConfig.auth.username}:${openhabConfig.auth.password}`
            ).toString("base64")
            headers["Authorization"] = `Basic ${auth}`
        }

        const response = await fetch(`${openhabConfig.baseUrl}/rest/`, {
            method: "GET",
            headers
        })

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        log.write("INFO", "OpenHAB connection test successful")
        return true
    } catch (err) {
        log.write("ERROR", `OpenHAB connection test failed: ${(err as Error).message}`)
        return false
    }
}
```

### File 2: Modified `src/app/listeners.ts`
Add these imports at the top:
```typescript
import { sendOpenHAB, OpenHABEventData } from "./openhab"
```

Add these IPC listeners in the `listeners.set()` function:
```typescript
// OpenHAB event handlers
ipcMain.on("openhabGameEnded", (event, data: OpenHABEventData) => {
    sendOpenHAB("game_ended", data)
})

ipcMain.on("openhabAchievement", (event, data: OpenHABEventData) => {
    sendOpenHAB("achievement_unlocked", data)
})
```

Modify the `ipcMain.on("showtrack", ...)` handler (line ~382):
```typescript
ipcMain.on("showtrack", async (event, gamename: string, ra?: { icon: string, gameartlibhero: string }) => {
    const config = sanconfig.get()
    
    // Send to OpenHAB if enabled
    if (config.get("openhab.enabled") && config.get("openhab.events.gameStarted.enabled")) {
        await sendOpenHAB("game_started", {
            gamename,
            timestamp: new Date().toISOString(),
            appid,
            ra: ra ? true : false
        })
    }
    
    // Skip GUI notification if OpenHAB is replacing notifications
    if (config.get("openhab.disableNotifications")) return
    
    // ... rest of existing code ...
})
```

### File 3: Modified `src/app/worker.ts`
Modify the game loop termination (line ~220):
```typescript
const gameloop = () => {
    if (processes.every(({ pid }: ProcessInfo) => pid !== -1 && !isprocessrunning(pid))) {
        clearInterval(timer!)
        log.write("INFO", "Game loop stopped")
        
        // Send game ended event to OpenHAB
        const config = sanconfig.get()
        if (config.get("openhab.enabled") && config.get("openhab.events.gameEnded.enabled")) {
            ipcRenderer.send("openhabGameEnded", {
                gamename: gamename || "???",
                appid,
                timestamp: new Date().toISOString(),
                steam3id
            })
        }
        
        ipcRenderer.send("validateworker")
        // ... rest of existing code ...
    }
}
```

Modify the achievement unlock handler (line ~318):
```typescript
unlocked.forEach(async (achievement: Achievement) => {
    log.write("INFO", `Achievement unlocked: ${JSON.stringify(achievement)}`)
    
    const config = sanconfig.get()
    const { rarity, semirarity, trophymode } = config.store
    const type = achievement.percent <= rarity ? "rare" : (trophymode && (achievement.percent <= semirarity && achievement.percent > rarity) ? "semi" : "main")
    
    // ... existing achievement processing code ...
    
    const notify: Notify = {
        // ... existing notify object ...
    }
    
    // Send to OpenHAB if enabled
    if (config.get("openhab.enabled") && config.get("openhab.events.achievementUnlocked.enabled")) {
        ipcRenderer.send("openhabAchievement", {
            gamename: gamename || "???",
            appid,
            steam3id,
            timestamp: notify.unlocktime,
            achievement: {
                apiname: achievement.apiname,
                name: notify.name,
                desc: notify.desc,
                percent: achievement.percent,
                hidden: achievement.hidden,
                rarity: type,
                unlocktime: notify.unlocktime
            }
        })
    }
    
    // Only send GUI notification if not disabled
    if (!config.get("openhab.disableNotifications")) {
        ;["notify", "sendwebhook"].forEach(cmd => ipcRenderer.send(cmd, notify, undefined, themeswitch?.[1].src))
    }
    
    // ... rest of existing code ...
})
```

---

## UI Configuration Panel

Add a new section to the Settings menu for OpenHAB integration. This can be added similarly to the webhook configuration.

**Location:** Settings > OpenHAB Integration

Configuration fields:
1. **Enable OpenHAB Integration** (checkbox)
2. **Base URL** (text input) - e.g., `http://192.168.1.100:8080`
3. **Authentication** (collapsible section)
   - Username (text input)
   - Password (password input)
4. **Event Configuration** (collapsible sections for each event type)
   - **Game Started**
     - Enable (checkbox)
     - Item Name (text input)
     - Send Full Payload (checkbox)
   - **Game Ended**
     - Enable (checkbox)
     - Item Name (text input)
     - Send Full Payload (checkbox)
   - **Achievement Unlocked**
     - Enable (checkbox)
     - Item Name (text input)
     - Send Full Payload (checkbox)
5. **Disable GUI Notifications** (checkbox) - When enabled, suppresses all popup notifications
6. **Test Connection** (button) - Tests connectivity to OpenHAB

---

## OpenHAB Item Configuration Examples

### Simple String Items
```
String SAN_GameStarted "Game Started [%s]"
String SAN_GameEnded "Game Ended [%s]"
String SAN_Achievement "Achievement Unlocked [%s]"
```

### Items with Rules
```
String SAN_GameStarted "Game Started [%s]"
String SAN_Achievement "Achievement Unlocked [%s]"

rule "Announce Game Started"
when
    Item SAN_GameStarted received update
then
    say("Now tracking: " + SAN_GameStarted.state.toString())
end

rule "Announce Achievement"
when
    Item SAN_Achievement received update
then
    say("Achievement unlocked: " + SAN_Achievement.state.toString())
end
```

### Complex JSON Payload Items
```
String SAN_GameStarted_JSON "Game Started JSON"
String SAN_Achievement_JSON "Achievement JSON"

rule "Parse Achievement JSON"
when
    Item SAN_Achievement_JSON received update
then
    val json = transform("JSONPATH", "$.achievement.name", SAN_Achievement_JSON.state.toString())
    val rarity = transform("JSONPATH", "$.achievement.rarity", SAN_Achievement_JSON.state.toString())
    say("You unlocked a " + rarity + " achievement: " + json)
end
```

---

## Testing Plan

1. **Unit Tests**
   - Test HTTP request formatting
   - Test authentication header generation
   - Test error handling

2. **Integration Tests**
   - Test with local OpenHAB instance
   - Verify simple state updates work
   - Verify JSON payload events work
   - Test authentication (basic auth)

3. **Manual Testing**
   - Launch a game and verify "Game Started" event
   - Close a game and verify "Game Ended" event
   - Unlock an achievement and verify "Achievement Unlocked" event
   - Test with GUI notifications disabled
   - Test with OpenHAB integration disabled (ensure app works normally)

---

## Migration Path

This enhancement is **fully backward compatible**:
- Default configuration has OpenHAB integration disabled
- All existing notification functionality remains unchanged
- Users can enable OpenHAB integration without affecting existing features
- Users can run both OpenHAB integration AND GUI notifications simultaneously
- Only when `disableNotifications` is enabled will GUI popups be suppressed

---

## Configuration Schema Changes

Add to `src/app/config.ts`:

```typescript
openhab: {
    type: "object",
    default: {
        enabled: false,
        baseUrl: "",
        auth: {
            username: "",
            password: ""
        },
        events: {
            gameStarted: {
                enabled: true,
                itemName: "SAN_GameStarted",
                sendPayload: false
            },
            gameEnded: {
                enabled: true,
                itemName: "SAN_GameEnded",
                sendPayload: false
            },
            achievementUnlocked: {
                enabled: true,
                itemName: "SAN_Achievement",
                sendPayload: false
            }
        },
        disableNotifications: false
    }
}
```

---

## Future Enhancements

1. **Additional Events**
   - 100% completion notification
   - Retro Achievements unlock
   - Error notifications

2. **Advanced OpenHAB Features**
   - Support for OpenHAB Cloud connector
   - Support for WebSocket updates
   - Support for MQTT publishing

3. **UI Improvements**
   - Visual indicator when OpenHAB request succeeds/fails
   - Event history log in UI
   - Test notification button for each event type

---

## Summary

This enhancement minimally modifies the Steam Achievement Notifier codebase to add OpenHAB REST API integration. The changes:
- ✅ Add one new module (`openhab.ts`)
- ✅ Modify 3 key locations in existing code (game start, game end, achievement unlock)
- ✅ Add configuration options to enable/disable the integration
- ✅ Maintain full backward compatibility
- ✅ Allow users to run both systems or choose one
- ✅ Follow existing patterns (similar to webhook integration)
- ✅ Provide comprehensive error handling and logging
