# PhonePilot POC — Part 1: Headless Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build PhonePilot's reasoning core — the perceive→decide→act loop, LLM client, UI-tree serializer, and action model — as pure Kotlin, fully unit-tested on the JVM with no Android device required.

**Architecture:** The agent brain never touches Android directly. It perceives and acts through a `DeviceController` interface and calls an LLM through an `LlmClient` interface. Both have fakes for testing. An `Orchestrator` runs the loop: `snapshot()` → serialize tree → ask LLM for the next `AgentAction` → execute it via `DeviceController` → feed the result back → repeat until `TaskComplete`, `AskUser`, an error, or the step cap. Part 2 supplies the real Android `DeviceController` (an `AccessibilityService`); this plan supplies everything the brain needs and a headless end-to-end test proving the whole loop works against fakes.

**Tech Stack:** Kotlin 2.0, Gradle (Kotlin DSL), kotlinx.coroutines, kotlinx.serialization (JSON), OkHttp + MockWebServer (LLM transport + tests), JUnit5 + kotlin.test.

## Global Constraints

- Language: **Kotlin 2.0**, JVM target 17.
- The `core` module is **pure Kotlin/JVM** — it MUST NOT import any `android.*` class. This is what keeps it unit-testable. (Part 2's Android module depends on `core`, not the reverse.)
- LLM access is **provider-agnostic** behind `LlmClient`. The concrete implementation targets an **OpenAI-compatible chat-completions endpoint** (works with OpenRouter free models, and others), model configurable.
- Perception is **tree-only** for the POC (no screenshots) — confirmed viable by the spike (`spike/treedump.py` results: YouTube 18 labelled tappables, Blinkit driven end-to-end).
- The LLM returns actions as **strict JSON** matching the schema in Task 4; the client validates and reprompts on malformed output (max 2 retries).
- Element indices are **re-assigned every snapshot** and never persisted across steps.
- Default step cap: **25**.
- Package root: `com.phonepilot.core`.

---

## File Structure

```
phonepilot/
  settings.gradle.kts                         # includes :core
  build.gradle.kts                            # root
  core/
    build.gradle.kts                          # pure-Kotlin/JVM module
    src/main/kotlin/com/phonepilot/core/
      model/UiNode.kt                         # UiNode, UiSnapshot, Bounds
      model/AgentAction.kt                    # sealed AgentAction + ActionResult
      device/DeviceController.kt              # interface the brain acts through
      perception/TreeSerializer.kt            # UiNode tree -> compact indexed text + index map
      llm/LlmClient.kt                        # interface + LlmContext + AgentEvent
      llm/ActionJson.kt                       # JSON <-> AgentAction (kotlinx.serialization)
      llm/PromptBuilder.kt                    # system prompt + state -> request messages
      llm/OpenAiCompatibleLlmClient.kt        # OkHttp impl of LlmClient
      agent/Orchestrator.kt                   # the perceive->decide->act loop
    src/test/kotlin/com/phonepilot/core/
      testutil/FakeDeviceController.kt        # scripted device for tests
      testutil/FakeLlmClient.kt               # scripted brain for tests
      perception/TreeSerializerTest.kt
      llm/ActionJsonTest.kt
      llm/PromptBuilderTest.kt
      llm/OpenAiCompatibleLlmClientTest.kt
      agent/OrchestratorTest.kt
      agent/EndToEndLoopTest.kt
```

---

## Task 1: Project scaffold + pure-Kotlin core module

**Files:**
- Create: `settings.gradle.kts`, `build.gradle.kts`, `core/build.gradle.kts`
- Test: `core/src/test/kotlin/com/phonepilot/core/ScaffoldTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable `:core` module with a working JVM unit-test harness.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/ScaffoldTest.kt`:
```kotlin
package com.phonepilot.core

import kotlin.test.Test
import kotlin.test.assertEquals

class ScaffoldTest {
    @Test fun harnessRuns() {
        assertEquals(4, 2 + 2)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test`
Expected: FAIL — build error, `:core` module / Gradle files do not exist yet.

- [ ] **Step 3: Create the Gradle files**

`settings.gradle.kts`:
```kotlin
rootProject.name = "phonepilot"
include(":core")
```

`build.gradle.kts` (root):
```kotlin
plugins {
    kotlin("jvm") version "2.0.20" apply false
    kotlin("plugin.serialization") version "2.0.20" apply false
}
```

`core/build.gradle.kts`:
```kotlin
plugins {
    kotlin("jvm") version "2.0.20"
    kotlin("plugin.serialization") version "2.0.20"
}
repositories { mavenCentral() }
kotlin { jvmToolchain(17) }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
tasks.test { useJUnitPlatform() }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test`
Expected: PASS — `ScaffoldTest.harnessRuns`.

- [ ] **Step 5: Commit**

```bash
git add settings.gradle.kts build.gradle.kts core/build.gradle.kts core/src/test/kotlin/com/phonepilot/core/ScaffoldTest.kt
git commit -m "chore: scaffold pure-Kotlin core module with test harness"
```

---

## Task 2: Perception + snapshot models (`UiNode`, `UiSnapshot`, `Bounds`)

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/model/UiNode.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/model/UiNodeTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) { val centerX; val centerY }`
  - `data class UiNode(val text: String?, val contentDesc: String?, val className: String?, val clickable: Boolean, val editable: Boolean, val bounds: Bounds, val children: List<UiNode>)` with `val label: String?` (text ?: contentDesc, trimmed, null if blank).
  - `data class UiSnapshot(val foregroundPackage: String, val root: UiNode)`.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/model/UiNodeTest.kt`:
```kotlin
package com.phonepilot.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UiNodeTest {
    @Test fun boundsCenter() {
        val b = Bounds(0, 0, 100, 200)
        assertEquals(50, b.centerX)
        assertEquals(100, b.centerY)
    }

    @Test fun labelPrefersTextThenContentDesc() {
        val z = Bounds(0, 0, 1, 1)
        assertEquals("Search", node(text = "Search", contentDesc = "x").label)
        assertEquals("Send", node(text = null, contentDesc = "Send").label)
        assertNull(node(text = "  ", contentDesc = null).label)
    }

    private fun node(text: String?, contentDesc: String?) =
        UiNode(text, contentDesc, "android.widget.Button", true, false, Bounds(0, 0, 1, 1), emptyList())
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*UiNodeTest"`
Expected: FAIL — `Bounds`/`UiNode` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/model/UiNode.kt`:
```kotlin
package com.phonepilot.core.model

data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val centerX: Int get() = (left + right) / 2
    val centerY: Int get() = (top + bottom) / 2
}

data class UiNode(
    val text: String?,
    val contentDesc: String?,
    val className: String?,
    val clickable: Boolean,
    val editable: Boolean,
    val bounds: Bounds,
    val children: List<UiNode>,
) {
    val label: String?
        get() = (text?.takeIf { it.isNotBlank() } ?: contentDesc?.takeIf { it.isNotBlank() })?.trim()
}

data class UiSnapshot(val foregroundPackage: String, val root: UiNode)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*UiNodeTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/model/UiNode.kt core/src/test/kotlin/com/phonepilot/core/model/UiNodeTest.kt
git commit -m "feat(core): add UiNode/UiSnapshot perception models"
```

---

## Task 3: Action model (`AgentAction`, `ActionResult`)

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/model/AgentAction.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/model/AgentActionTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sealed interface AgentAction` with: `OpenApp(pkg: String)`, `TapElement(index: Int)`, `TypeText(index: Int, text: String)`, `Scroll(direction: ScrollDirection)`, `PressBack`, `Wait(millis: Long)`, `AskUser(question: String)`, `TaskComplete(summary: String)`.
  - `enum class ScrollDirection { UP, DOWN }`
  - `data class ActionResult(val success: Boolean, val message: String)`.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/model/AgentActionTest.kt`:
```kotlin
package com.phonepilot.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AgentActionTest {
    @Test fun actionsCarryTheirData() {
        assertEquals("com.x", (AgentAction.OpenApp("com.x")).pkg)
        assertEquals(7, (AgentAction.TapElement(7)).index)
        val t = AgentAction.TypeText(3, "milk")
        assertEquals(3, t.index); assertEquals("milk", t.text)
        assertTrue(AgentAction.PressBack is AgentAction)
    }

    @Test fun resultHoldsOutcome() {
        val r = ActionResult(success = false, message = "no such element")
        assertEquals(false, r.success)
        assertEquals("no such element", r.message)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*AgentActionTest"`
Expected: FAIL — `AgentAction` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/model/AgentAction.kt`:
```kotlin
package com.phonepilot.core.model

enum class ScrollDirection { UP, DOWN }

sealed interface AgentAction {
    data class OpenApp(val pkg: String) : AgentAction
    data class TapElement(val index: Int) : AgentAction
    data class TypeText(val index: Int, val text: String) : AgentAction
    data class Scroll(val direction: ScrollDirection) : AgentAction
    data object PressBack : AgentAction
    data class Wait(val millis: Long) : AgentAction
    data class AskUser(val question: String) : AgentAction
    data class TaskComplete(val summary: String) : AgentAction
}

data class ActionResult(val success: Boolean, val message: String)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*AgentActionTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/model/AgentAction.kt core/src/test/kotlin/com/phonepilot/core/model/AgentActionTest.kt
git commit -m "feat(core): add AgentAction sealed model and ActionResult"
```

---

## Task 4: `TreeSerializer` — UI tree → compact indexed text + index map

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/perception/TreeSerializer.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/perception/TreeSerializerTest.kt`

**Interfaces:**
- Consumes: `UiNode`, `UiSnapshot` (Task 2).
- Produces:
  - `data class SerializedTree(val text: String, val index: Map<Int, UiNode>)`.
  - `object TreeSerializer { fun serialize(snapshot: UiSnapshot): SerializedTree }`.
  - Behavior: depth-first walk; assign a 0-based index ONLY to nodes that are `clickable` OR `editable` OR have a non-null `label`. Each indexed node emits one line: `#<idx> [<kind>] "<label>" (x,y)` where `<kind>` ∈ `tap`/`type`/`text`, `x,y` = bounds center. Non-interesting nodes contribute nothing. `index` maps each printed idx → its `UiNode`.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/perception/TreeSerializerTest.kt`:
```kotlin
package com.phonepilot.core.perception

import com.phonepilot.core.model.Bounds
import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TreeSerializerTest {
    private fun leaf(text: String?, cd: String?, clickable: Boolean, editable: Boolean) =
        UiNode(text, cd, "cls", clickable, editable, Bounds(0, 0, 20, 40), emptyList())

    @Test fun indexesOnlyInterestingNodes_andMapsThem() {
        val root = UiNode(
            null, null, "root", false, false, Bounds(0, 0, 100, 100),
            listOf(
                leaf("Search", null, true, false),   // tappable + label -> #0
                leaf(null, null, false, false),       // boring -> skipped
                leaf(null, "Send", true, false),       // tappable + label -> #1
                leaf(null, null, false, true),          // editable, no label -> #2
            ),
        )
        val s = TreeSerializer.serialize(UiSnapshot("com.x", root))
        assertEquals(3, s.index.size)
        assertEquals("Search", s.index[0]!!.label)
        assertEquals("Send", s.index[1]!!.label)
        assertTrue(s.index[2]!!.editable)
        assertTrue(s.text.contains("#0 [tap] \"Search\" (10,20)"))
        assertTrue(s.text.contains("#1 [tap] \"Send\" (10,20)"))
        assertTrue(s.text.contains("#2 [type]"))
    }

    @Test fun textOnlyNodeUsesTextKind() {
        val root = UiNode(null, null, "root", false, false, Bounds(0, 0, 1, 1),
            listOf(leaf("Delivering to Home", null, false, false)))
        val s = TreeSerializer.serialize(UiSnapshot("com.x", root))
        assertTrue(s.text.contains("#0 [text] \"Delivering to Home\""))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*TreeSerializerTest"`
Expected: FAIL — `TreeSerializer` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/perception/TreeSerializer.kt`:
```kotlin
package com.phonepilot.core.perception

import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot

data class SerializedTree(val text: String, val index: Map<Int, UiNode>)

object TreeSerializer {
    fun serialize(snapshot: UiSnapshot): SerializedTree {
        val lines = StringBuilder()
        val index = LinkedHashMap<Int, UiNode>()
        var next = 0
        fun visit(node: UiNode) {
            val interesting = node.clickable || node.editable || node.label != null
            if (interesting) {
                val idx = next++
                index[idx] = node
                val kind = when {
                    node.editable -> "type"
                    node.clickable -> "tap"
                    else -> "text"
                }
                val label = node.label ?: ""
                lines.append("#$idx [$kind] \"$label\" (${node.bounds.centerX},${node.bounds.centerY})\n")
            }
            node.children.forEach(::visit)
        }
        visit(snapshot.root)
        return SerializedTree(lines.toString().trimEnd(), index)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*TreeSerializerTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/perception/TreeSerializer.kt core/src/test/kotlin/com/phonepilot/core/perception/TreeSerializerTest.kt
git commit -m "feat(core): serialize UI tree to indexed compact text"
```

---

## Task 5: `DeviceController` interface + fakes

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/device/DeviceController.kt`
- Create: `core/src/test/kotlin/com/phonepilot/core/testutil/FakeDeviceController.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/testutil/FakeDeviceControllerTest.kt`

**Interfaces:**
- Consumes: `UiSnapshot`, `AgentAction`, `ActionResult`.
- Produces:
  - `interface DeviceController { suspend fun snapshot(): UiSnapshot; suspend fun execute(action: AgentAction): ActionResult }`.
  - `FakeDeviceController(snapshots: List<UiSnapshot>)`: returns snapshots in order (repeats last), records every `execute` call in `val executed: MutableList<AgentAction>`, returns `ActionResult(true, "ok")` unless an action is registered to fail.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/testutil/FakeDeviceControllerTest.kt`:
```kotlin
package com.phonepilot.core.testutil

import com.phonepilot.core.model.*
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class FakeDeviceControllerTest {
    private fun snap(pkg: String) = UiSnapshot(pkg, UiNode(null, null, "r", false, false, Bounds(0,0,1,1), emptyList()))

    @Test fun servesSnapshotsInOrderThenRepeatsLast() = runTest {
        val d = FakeDeviceController(listOf(snap("a"), snap("b")))
        assertEquals("a", d.snapshot().foregroundPackage)
        assertEquals("b", d.snapshot().foregroundPackage)
        assertEquals("b", d.snapshot().foregroundPackage)
    }

    @Test fun recordsExecutedActions() = runTest {
        val d = FakeDeviceController(listOf(snap("a")))
        d.execute(AgentAction.TapElement(2))
        assertEquals(listOf(AgentAction.TapElement(2)), d.executed)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*FakeDeviceControllerTest"`
Expected: FAIL — `DeviceController`/`FakeDeviceController` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/device/DeviceController.kt`:
```kotlin
package com.phonepilot.core.device

import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.UiSnapshot

interface DeviceController {
    suspend fun snapshot(): UiSnapshot
    suspend fun execute(action: AgentAction): ActionResult
}
```

`core/src/test/kotlin/com/phonepilot/core/testutil/FakeDeviceController.kt`:
```kotlin
package com.phonepilot.core.testutil

import com.phonepilot.core.device.DeviceController
import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.UiSnapshot

class FakeDeviceController(
    private val snapshots: List<UiSnapshot>,
    private val failures: Map<AgentAction, String> = emptyMap(),
) : DeviceController {
    val executed = mutableListOf<AgentAction>()
    private var i = 0

    override suspend fun snapshot(): UiSnapshot {
        val s = snapshots[i.coerceAtMost(snapshots.lastIndex)]
        i++
        return s
    }

    override suspend fun execute(action: AgentAction): ActionResult {
        executed += action
        failures[action]?.let { return ActionResult(false, it) }
        return ActionResult(true, "ok")
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*FakeDeviceControllerTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/device/DeviceController.kt core/src/test/kotlin/com/phonepilot/core/testutil/FakeDeviceController.kt core/src/test/kotlin/com/phonepilot/core/testutil/FakeDeviceControllerTest.kt
git commit -m "feat(core): add DeviceController interface + test fake"
```

---

## Task 6: `ActionJson` — JSON ↔ `AgentAction`

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/llm/ActionJson.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/llm/ActionJsonTest.kt`

**Interfaces:**
- Consumes: `AgentAction`, `ScrollDirection` (Task 3).
- Produces:
  - `object ActionJson { fun parse(json: String): AgentAction; fun schemaDoc(): String }`.
  - Wire format: `{"action":"tap","index":7}` etc. Mapping: `open`(pkg), `tap`(index), `type`(index,text), `scroll`(direction:"up"|"down"), `back`, `wait`(millis), `ask`(question), `done`(summary).
  - `parse` throws `ActionParseException(message)` on unknown/missing fields. Tolerates leading/trailing prose and ```` ```json ```` fences by extracting the first `{...}` block.
  - `schemaDoc()` returns the human-readable schema string embedded in the system prompt (Task 8).

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/llm/ActionJsonTest.kt`:
```kotlin
package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.ScrollDirection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ActionJsonTest {
    @Test fun parsesEachActionType() {
        assertEquals(AgentAction.OpenApp("com.x"), ActionJson.parse("""{"action":"open","pkg":"com.x"}"""))
        assertEquals(AgentAction.TapElement(7), ActionJson.parse("""{"action":"tap","index":7}"""))
        assertEquals(AgentAction.TypeText(2, "milk"), ActionJson.parse("""{"action":"type","index":2,"text":"milk"}"""))
        assertEquals(AgentAction.Scroll(ScrollDirection.DOWN), ActionJson.parse("""{"action":"scroll","direction":"down"}"""))
        assertEquals(AgentAction.PressBack, ActionJson.parse("""{"action":"back"}"""))
        assertEquals(AgentAction.TaskComplete("done"), ActionJson.parse("""{"action":"done","summary":"done"}"""))
    }

    @Test fun stripsFencesAndProse() {
        val raw = "Sure!\n```json\n{\"action\":\"tap\",\"index\":1}\n```"
        assertEquals(AgentAction.TapElement(1), ActionJson.parse(raw))
    }

    @Test fun rejectsUnknownAction() {
        assertFailsWith<ActionParseException> { ActionJson.parse("""{"action":"fly"}""") }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*ActionJsonTest"`
Expected: FAIL — `ActionJson` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/llm/ActionJson.kt`:
```kotlin
package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.ScrollDirection
import kotlinx.serialization.json.*

class ActionParseException(message: String) : Exception(message)

object ActionJson {
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(raw: String): AgentAction {
        val start = raw.indexOf('{')
        val end = raw.lastIndexOf('}')
        if (start < 0 || end <= start) throw ActionParseException("no JSON object in: $raw")
        val obj = try {
            json.parseToJsonElement(raw.substring(start, end + 1)).jsonObject
        } catch (e: Exception) {
            throw ActionParseException("invalid JSON: ${e.message}")
        }
        fun str(k: String) = obj[k]?.jsonPrimitive?.contentOrNull
            ?: throw ActionParseException("missing '$k'")
        fun int(k: String) = obj[k]?.jsonPrimitive?.intOrNull
            ?: throw ActionParseException("missing int '$k'")
        return when (val a = str("action")) {
            "open" -> AgentAction.OpenApp(str("pkg"))
            "tap" -> AgentAction.TapElement(int("index"))
            "type" -> AgentAction.TypeText(int("index"), str("text"))
            "scroll" -> AgentAction.Scroll(
                if (str("direction").equals("up", true)) ScrollDirection.UP else ScrollDirection.DOWN
            )
            "back" -> AgentAction.PressBack
            "wait" -> AgentAction.Wait(obj["millis"]?.jsonPrimitive?.longOrNull ?: 1000L)
            "ask" -> AgentAction.AskUser(str("question"))
            "done" -> AgentAction.TaskComplete(str("summary"))
            else -> throw ActionParseException("unknown action '$a'")
        }
    }

    fun schemaDoc(): String = """
        Reply with EXACTLY ONE JSON object, no prose. One of:
        {"action":"open","pkg":"<package>"}
        {"action":"tap","index":<int>}
        {"action":"type","index":<int>,"text":"<text>"}
        {"action":"scroll","direction":"up|down"}
        {"action":"back"}
        {"action":"wait","millis":<int>}
        {"action":"ask","question":"<text>"}
        {"action":"done","summary":"<text>"}
    """.trimIndent()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*ActionJsonTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/llm/ActionJson.kt core/src/test/kotlin/com/phonepilot/core/llm/ActionJsonTest.kt
git commit -m "feat(core): JSON parsing for agent actions"
```

---

## Task 7: `LlmClient` interface, `LlmContext`, `AgentEvent`

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/llm/LlmClient.kt`
- Create: `core/src/test/kotlin/com/phonepilot/core/testutil/FakeLlmClient.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/testutil/FakeLlmClientTest.kt`

**Interfaces:**
- Consumes: `AgentAction`.
- Produces:
  - `data class Step(val action: String, val resultMessage: String)` — one prior loop step.
  - `data class LlmContext(val task: String, val foregroundPackage: String, val serializedTree: String, val history: List<Step>)`.
  - `interface LlmClient { suspend fun nextAction(context: LlmContext): AgentAction }`.
  - `FakeLlmClient(script: List<AgentAction>)`: returns scripted actions in order; throws `IllegalStateException` if asked past the end (guards against runaway loops in tests). Records each `LlmContext` in `val seen: MutableList<LlmContext>`.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/testutil/FakeLlmClientTest.kt`:
```kotlin
package com.phonepilot.core.testutil

import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.model.AgentAction
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class FakeLlmClientTest {
    @Test fun returnsScriptedActionsAndRecordsContext() = runTest {
        val f = FakeLlmClient(listOf(AgentAction.TapElement(1), AgentAction.TaskComplete("x")))
        val ctx = LlmContext("task", "com.x", "#0 [tap] \"a\" (1,1)", emptyList())
        assertEquals(AgentAction.TapElement(1), f.nextAction(ctx))
        assertEquals(AgentAction.TaskComplete("x"), f.nextAction(ctx))
        assertEquals(2, f.seen.size)
        assertEquals("task", f.seen.first().task)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*FakeLlmClientTest"`
Expected: FAIL — `LlmClient`/`LlmContext`/`FakeLlmClient` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/llm/LlmClient.kt`:
```kotlin
package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction

data class Step(val action: String, val resultMessage: String)

data class LlmContext(
    val task: String,
    val foregroundPackage: String,
    val serializedTree: String,
    val history: List<Step>,
)

interface LlmClient {
    suspend fun nextAction(context: LlmContext): AgentAction
}
```

`core/src/test/kotlin/com/phonepilot/core/testutil/FakeLlmClient.kt`:
```kotlin
package com.phonepilot.core.testutil

import com.phonepilot.core.llm.LlmClient
import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.model.AgentAction

class FakeLlmClient(private val script: List<AgentAction>) : LlmClient {
    val seen = mutableListOf<LlmContext>()
    private var i = 0
    override suspend fun nextAction(context: LlmContext): AgentAction {
        seen += context
        check(i < script.size) { "FakeLlmClient asked for action ${i + 1} but script has ${script.size}" }
        return script[i++]
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*FakeLlmClientTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/llm/LlmClient.kt core/src/test/kotlin/com/phonepilot/core/testutil/FakeLlmClient.kt core/src/test/kotlin/com/phonepilot/core/testutil/FakeLlmClientTest.kt
git commit -m "feat(core): add LlmClient interface, LlmContext, test fake"
```

---

## Task 8: `PromptBuilder` — context → chat messages

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/llm/PromptBuilder.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/llm/PromptBuilderTest.kt`

**Interfaces:**
- Consumes: `LlmContext` (Task 7), `ActionJson.schemaDoc()` (Task 6).
- Produces:
  - `data class ChatMessage(val role: String, val content: String)`.
  - `object PromptBuilder { fun build(context: LlmContext): List<ChatMessage> }`.
  - System message: role of the agent + `ActionJson.schemaDoc()` + rule "only use indices present in the CURRENT screen". User message: the task, foreground package, the serialized tree, and a compact history (`action -> result` lines).

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/llm/PromptBuilderTest.kt`:
```kotlin
package com.phonepilot.core.llm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PromptBuilderTest {
    @Test fun systemMessageCarriesSchemaAndRules() {
        val msgs = PromptBuilder.build(LlmContext("t", "com.x", "#0 [tap] \"a\" (1,1)", emptyList()))
        assertEquals("system", msgs.first().role)
        assertTrue(msgs.first().content.contains("\"action\":\"tap\""))
        assertTrue(msgs.first().content.lowercase().contains("current screen"))
    }

    @Test fun userMessageCarriesTaskTreeAndHistory() {
        val ctx = LlmContext(
            task = "open youtube",
            foregroundPackage = "com.launcher",
            serializedTree = "#0 [tap] \"YouTube\" (5,5)",
            history = listOf(Step("""{"action":"open","pkg":"com.x"}""", "ok")),
        )
        val user = PromptBuilder.build(ctx).last()
        assertEquals("user", user.role)
        assertTrue(user.content.contains("open youtube"))
        assertTrue(user.content.contains("com.launcher"))
        assertTrue(user.content.contains("#0 [tap] \"YouTube\" (5,5)"))
        assertTrue(user.content.contains("ok"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*PromptBuilderTest"`
Expected: FAIL — `PromptBuilder`/`ChatMessage` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/llm/PromptBuilder.kt`:
```kotlin
package com.phonepilot.core.llm

data class ChatMessage(val role: String, val content: String)

object PromptBuilder {
    fun build(context: LlmContext): List<ChatMessage> {
        val system = buildString {
            appendLine("You are PhonePilot, an agent that operates an Android phone to complete the user's task.")
            appendLine("You are given the task, the current foreground app, and a list of on-screen elements.")
            appendLine("Each element has an index (#N), a kind ([tap]/[type]/[text]), a label, and screen coordinates.")
            appendLine("Only use indices that are present in the CURRENT screen listing. Indices change every step.")
            appendLine("Choose the single best next action. When the task is fully done, use the \"done\" action.")
            appendLine()
            append(ActionJson.schemaDoc())
        }
        val user = buildString {
            appendLine("TASK: ${context.task}")
            appendLine("FOREGROUND APP: ${context.foregroundPackage}")
            appendLine()
            appendLine("SCREEN ELEMENTS:")
            appendLine(context.serializedTree.ifBlank { "(no interactable elements found)" })
            if (context.history.isNotEmpty()) {
                appendLine()
                appendLine("HISTORY (most recent last):")
                context.history.forEach { appendLine("- ${it.action} -> ${it.resultMessage}") }
            }
        }
        return listOf(ChatMessage("system", system), ChatMessage("user", user))
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*PromptBuilderTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/llm/PromptBuilder.kt core/src/test/kotlin/com/phonepilot/core/llm/PromptBuilderTest.kt
git commit -m "feat(core): build chat messages from agent context"
```

---

## Task 9: `OpenAiCompatibleLlmClient` — real transport (OkHttp) with retry

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/llm/OpenAiCompatibleLlmClient.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/llm/OpenAiCompatibleLlmClientTest.kt`

**Interfaces:**
- Consumes: `LlmClient`, `LlmContext`, `PromptBuilder`, `ChatMessage`, `ActionJson`, `ActionParseException`.
- Produces:
  - `class OpenAiCompatibleLlmClient(baseUrl: String, apiKey: String, model: String, http: OkHttpClient = OkHttpClient(), maxParseRetries: Int = 2) : LlmClient`.
  - POSTs `"$baseUrl/chat/completions"` with `{model, messages, temperature:0}`; parses `choices[0].message.content`; runs `ActionJson.parse`. On `ActionParseException`, retries up to `maxParseRetries` appending a corrective user message. On HTTP failure throws `LlmTransportException`.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/llm/OpenAiCompatibleLlmClientTest.kt`:
```kotlin
package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class OpenAiCompatibleLlmClientTest {
    private val server = MockWebServer()
    private fun body(content: String) =
        """{"choices":[{"message":{"role":"assistant","content":${quote(content)}}}]}"""
    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    @AfterTest fun tearDown() = server.shutdown()

    private fun client() = OpenAiCompatibleLlmClient(
        baseUrl = server.url("/v1").toString(), apiKey = "k", model = "test/model")
    private val ctx = LlmContext("t", "com.x", "#0 [tap] \"a\" (1,1)", emptyList())

    @Test fun parsesActionFromResponse() = runTest {
        server.enqueue(MockResponse().setBody(body("""{"action":"tap","index":0}""")))
        assertEquals(AgentAction.TapElement(0), client().nextAction(ctx))
    }

    @Test fun retriesOnMalformedThenSucceeds() = runTest {
        server.enqueue(MockResponse().setBody(body("I cannot help")))       // no JSON
        server.enqueue(MockResponse().setBody(body("""{"action":"done","summary":"ok"}""")))
        assertEquals(AgentAction.TaskComplete("ok"), client().nextAction(ctx))
        assertEquals(2, server.requestCount)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*OpenAiCompatibleLlmClientTest"`
Expected: FAIL — `OpenAiCompatibleLlmClient` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/llm/OpenAiCompatibleLlmClient.kt`:
```kotlin
package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class LlmTransportException(message: String) : Exception(message)

class OpenAiCompatibleLlmClient(
    private val baseUrl: String,
    private val apiKey: String,
    private val model: String,
    private val http: OkHttpClient = OkHttpClient(),
    private val maxParseRetries: Int = 2,
) : LlmClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "application/json".toMediaType()

    override suspend fun nextAction(context: LlmContext): AgentAction {
        val messages = PromptBuilder.build(context).toMutableList()
        var lastError: String? = null
        repeat(maxParseRetries + 1) {
            val content = call(messages)
            try {
                return ActionJson.parse(content)
            } catch (e: ActionParseException) {
                lastError = e.message
                messages += ChatMessage("assistant", content)
                messages += ChatMessage("user",
                    "That was not valid. ${e.message}. Reply with exactly one JSON action object and nothing else.")
            }
        }
        throw LlmTransportException("LLM did not return a valid action: $lastError")
    }

    private suspend fun call(messages: List<ChatMessage>): String = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("model", model)
            put("temperature", 0)
            putJsonArray("messages") {
                messages.forEach {
                    addJsonObject { put("role", it.role); put("content", it.content) }
                }
            }
        }
        val req = Request.Builder()
            .url("$baseUrl/chat/completions")
            .header("Authorization", "Bearer $apiKey")
            .post(payload.toString().toRequestBody(mediaType))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw LlmTransportException("HTTP ${resp.code}: $text")
            json.parseToJsonElement(text).jsonObject["choices"]
                ?.jsonArray?.getOrNull(0)?.jsonObject
                ?.get("message")?.jsonObject?.get("content")?.jsonPrimitive?.contentOrNull
                ?: throw LlmTransportException("no content in response: $text")
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*OpenAiCompatibleLlmClientTest"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/llm/OpenAiCompatibleLlmClient.kt core/src/test/kotlin/com/phonepilot/core/llm/OpenAiCompatibleLlmClientTest.kt
git commit -m "feat(core): OpenAI-compatible LLM client with parse-retry"
```

---

## Task 10: `Orchestrator` — the perceive→decide→act loop

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/agent/OrchestratorTest.kt`

**Interfaces:**
- Consumes: `DeviceController` (Task 5), `LlmClient`/`LlmContext`/`Step` (Task 7), `TreeSerializer` (Task 4), `AgentAction`/`ActionResult` (Task 3), `ActionJson` (Task 6 — to render history lines).
- Produces:
  - `sealed interface AgentEvent { data class Acting(val step: Int, val action: AgentAction); data class Executed(val result: ActionResult); data class Finished(val outcome: Outcome) }`.
  - `enum class Outcome { COMPLETED, ASKED_USER, STEP_CAP, ERROR }`.
  - `class Orchestrator(device, llm, maxSteps=25)` with `suspend fun run(task: String, onEvent: (AgentEvent) -> Unit = {}): Outcome`.
  - Loop: `snapshot()` → `TreeSerializer.serialize` → build `LlmContext(task, pkg, tree, history)` → `llm.nextAction` (emit `Acting`) → on `TaskComplete`→COMPLETED, `AskUser`→ASKED_USER, else `device.execute` (emit `Executed`), append `Step` to history → repeat. Hitting `maxSteps` → STEP_CAP. Any thrown exception → ERROR. Always emits `Finished` last.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/agent/OrchestratorTest.kt`:
```kotlin
package com.phonepilot.core.agent

import com.phonepilot.core.model.*
import com.phonepilot.core.testutil.FakeDeviceController
import com.phonepilot.core.testutil.FakeLlmClient
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class OrchestratorTest {
    private fun snap(pkg: String) =
        UiSnapshot(pkg, UiNode("Search", null, "b", true, false, Bounds(0, 0, 10, 10), emptyList()))

    @Test fun executesActionsThenCompletes() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(listOf(AgentAction.TapElement(0), AgentAction.TaskComplete("done")))
        val events = mutableListOf<AgentEvent>()
        val outcome = Orchestrator(device, llm).run("task") { events += it }
        assertEquals(Outcome.COMPLETED, outcome)
        assertEquals(listOf<AgentAction>(AgentAction.TapElement(0)), device.executed)
    }

    @Test fun secondCallSeesFirstActionInHistory() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(listOf(AgentAction.TapElement(0), AgentAction.TaskComplete("done")))
        Orchestrator(device, llm).run("task")
        assertEquals(1, llm.seen[1].history.size)
        assertEquals("ok", llm.seen[1].history.first().resultMessage)
    }

    @Test fun stopsAtStepCap() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(List(10) { AgentAction.TapElement(0) })
        assertEquals(Outcome.STEP_CAP, Orchestrator(device, llm, maxSteps = 3).run("task"))
        assertEquals(3, device.executed.size)
    }

    @Test fun askUserStopsLoop() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(listOf(AgentAction.AskUser("which one?")))
        assertEquals(Outcome.ASKED_USER, Orchestrator(device, llm).run("task"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*OrchestratorTest"`
Expected: FAIL — `Orchestrator`/`AgentEvent`/`Outcome` unresolved.

- [ ] **Step 3: Write minimal implementation**

`core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt`:
```kotlin
package com.phonepilot.core.agent

import com.phonepilot.core.device.DeviceController
import com.phonepilot.core.llm.LlmClient
import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.llm.Step
import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.perception.TreeSerializer

enum class Outcome { COMPLETED, ASKED_USER, STEP_CAP, ERROR }

sealed interface AgentEvent {
    data class Acting(val step: Int, val action: AgentAction) : AgentEvent
    data class Executed(val result: ActionResult) : AgentEvent
    data class Finished(val outcome: Outcome) : AgentEvent
}

class Orchestrator(
    private val device: DeviceController,
    private val llm: LlmClient,
    private val maxSteps: Int = 25,
) {
    suspend fun run(task: String, onEvent: (AgentEvent) -> Unit = {}): Outcome {
        val history = mutableListOf<Step>()
        val outcome = try {
            loop(task, history, onEvent)
        } catch (e: Exception) {
            Outcome.ERROR
        }
        onEvent(AgentEvent.Finished(outcome))
        return outcome
    }

    private suspend fun loop(task: String, history: MutableList<Step>, onEvent: (AgentEvent) -> Unit): Outcome {
        for (step in 1..maxSteps) {
            val snapshot = device.snapshot()
            val tree = TreeSerializer.serialize(snapshot)
            val context = LlmContext(task, snapshot.foregroundPackage, tree.text, history.toList())
            val action = llm.nextAction(context)
            onEvent(AgentEvent.Acting(step, action))
            when (action) {
                is AgentAction.TaskComplete -> return Outcome.COMPLETED
                is AgentAction.AskUser -> return Outcome.ASKED_USER
                else -> {
                    val result = device.execute(action)
                    onEvent(AgentEvent.Executed(result))
                    history += Step(renderAction(action), result.message)
                }
            }
        }
        return Outcome.STEP_CAP
    }

    private fun renderAction(a: AgentAction): String = when (a) {
        is AgentAction.OpenApp -> "open ${a.pkg}"
        is AgentAction.TapElement -> "tap #${a.index}"
        is AgentAction.TypeText -> "type \"${a.text}\" into #${a.index}"
        is AgentAction.Scroll -> "scroll ${a.direction}"
        AgentAction.PressBack -> "back"
        is AgentAction.Wait -> "wait ${a.millis}ms"
        is AgentAction.AskUser -> "ask"
        is AgentAction.TaskComplete -> "done"
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :core:test --tests "*OrchestratorTest"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt core/src/test/kotlin/com/phonepilot/core/agent/OrchestratorTest.kt
git commit -m "feat(core): orchestrator perceive-decide-act loop"
```

---

## Task 11: Headless end-to-end test — loop drives a scripted "device" via a real LLM transport

**Files:**
- Test: `core/src/test/kotlin/com/phonepilot/core/agent/EndToEndLoopTest.kt`

**Interfaces:**
- Consumes: everything above + `MockWebServer` as a stand-in LLM.
- Produces: proof that `Orchestrator` + `OpenAiCompatibleLlmClient` + `TreeSerializer` + `FakeDeviceController` complete a two-step task ("open YouTube, then done") end to end, with the real JSON/prompt/parse path exercised.

- [ ] **Step 1: Write the failing test**

`core/src/test/kotlin/com/phonepilot/core/agent/EndToEndLoopTest.kt`:
```kotlin
package com.phonepilot.core.agent

import com.phonepilot.core.llm.OpenAiCompatibleLlmClient
import com.phonepilot.core.model.*
import com.phonepilot.core.testutil.FakeDeviceController
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class EndToEndLoopTest {
    private val server = MockWebServer()
    @AfterTest fun tearDown() = server.shutdown()
    private fun body(c: String) =
        """{"choices":[{"message":{"content":${"\"" + c.replace("\"","\\\"") + "\""}}}]}"""

    @Test fun completesOpenYouTubeTask() = runTest {
        // LLM says: open youtube, then done.
        server.enqueue(MockResponse().setBody(body("""{"action":"open","pkg":"com.google.android.youtube"}""")))
        server.enqueue(MockResponse().setBody(body("""{"action":"done","summary":"YouTube opened"}""")))
        val device = FakeDeviceController(listOf(
            UiSnapshot("com.launcher", UiNode("YouTube", null, "b", true, false, Bounds(0,0,10,10), emptyList())),
            UiSnapshot("com.google.android.youtube", UiNode(null, null, "r", false, false, Bounds(0,0,1,1), emptyList())),
        ))
        val llm = OpenAiCompatibleLlmClient(server.url("/v1").toString(), "k", "free/model")
        val events = mutableListOf<AgentEvent>()

        val outcome = Orchestrator(device, llm).run("open the YouTube app") { events += it }

        assertEquals(Outcome.COMPLETED, outcome)
        assertEquals(listOf<AgentAction>(AgentAction.OpenApp("com.google.android.youtube")), device.executed)
        assertEquals(AgentEvent.Finished(Outcome.COMPLETED), events.last())
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :core:test --tests "*EndToEndLoopTest"`
Expected: FAIL first if any wiring is off; otherwise it should compile and pass once all prior tasks are done. If it fails, fix wiring (do not modify the test's assertions).

- [ ] **Step 3: (Implementation already present)**

No new production code — this test composes existing units. If it fails to compile, the failure names the missing symbol; resolve by verifying earlier tasks' public signatures match this plan.

- [ ] **Step 4: Run the FULL suite**

Run: `./gradlew :core:test`
Expected: PASS — all tests across Tasks 1–11 green.

- [ ] **Step 5: Commit**

```bash
git add core/src/test/kotlin/com/phonepilot/core/agent/EndToEndLoopTest.kt
git commit -m "test(core): headless end-to-end loop drives a scripted device"
```

---

## What Part 1 delivers

A fully unit-tested agent brain (JVM, no Android) that: perceives a `UiSnapshot`, serializes it to indexed text, asks a real OpenAI-compatible LLM for the next JSON action, parses/validates it (with retry), executes it through a `DeviceController`, feeds results back, and terminates on done/ask/step-cap/error — emitting events a UI can render.

## Next plans (not in scope here)

- **Part 2 — Android Embodiment:** `AgentAccessibilityService implements DeviceController` (map `AccessibilityNodeInfo` → `UiNode`; perform node clicks / `ACTION_SET_TEXT` / clipboard-paste / scroll / global back; `openApp` via package intents; wait-for-idle on `WINDOW_CONTENT_CHANGED`), `VoiceManager` (SpeechRecognizer push-to-talk + TextToSpeech), floating bubble overlay + foreground service, permission setup wizard (accessibility deep-link, overlay, mic, API key in `EncryptedSharedPreferences`), and the wiring: tap bubble → speak → `Orchestrator.run(task)` → live step log. Manual on-device verification (per spec's testing strategy).
- **Part 3 — Cross-app + vision + confirmation gate:** screenshots via `takeScreenshot()` layered into `snapshot()`, coordinate-tap fallback, app-switch verification, and the confirmation gate on consequential actions.
