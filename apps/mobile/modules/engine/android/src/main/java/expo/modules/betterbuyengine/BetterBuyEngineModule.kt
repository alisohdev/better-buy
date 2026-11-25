package expo.modules.betterbuyengine

import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import mobileengine.Mobileengine
import org.json.JSONObject

class BetterBuyEngineModule : Module() {
  private val engine by lazy { Mobileengine.new_() }
  private var lastTransition = ""

  private fun <T> onWorker(block: () -> T): T {
    check(Looper.myLooper() != Looper.getMainLooper()) { "NATIVE_THREAD_VIOLATION" }
    return block()
  }

  @Synchronized
  private fun statusWithDiagnostics(): String {
    val snapshot = engine.status()
    // Read only fields emitted by the engine; never write the snapshot to logcat.
    runCatching {
      val data = JSONObject(snapshot)
      val id = data.optString("id")
      val state = data.optString("state")
      val transition = "$id:$state"
      if (id.matches(Regex("[0-9a-f]{32}")) &&
        state in setOf("running", "complete", "cancelled") && transition != lastTransition
      ) {
        lastTransition = transition
        Log.i("BetterBuyEngine", JSONObject()
          .put("event", "bridge_status")
          .put("scanId", id)
          .put("state", state)
          .put("engineVersion", engine.version())
          .put("mainThread", false).toString())
      }
    }
    return snapshot
  }

  override fun definition() = ModuleDefinition {
    Name("BetterBuyEngine")
    AsyncFunction("version") { onWorker { engine.version() } }
    AsyncFunction("start") { onWorker { engine.start() } }
    AsyncFunction("status") { onWorker { statusWithDiagnostics() } }
    AsyncFunction("cancel") { onWorker { engine.cancel() } }
    AsyncFunction("logs") { onWorker { engine.logs() } }
    AsyncFunction("controlledError") { onWorker { engine.controlledError() } }
  }
}
