import ExpoModulesCore
import BetterBuyEngineKit

public final class BetterBuyEngineModule: Module {
  private let engine = MobileengineNew()!

  public func definition() -> ModuleDefinition {
    Name("BetterBuyEngine")
    AsyncFunction("version") { self.engine.version() }
    AsyncFunction("start") { self.engine.start() }
    AsyncFunction("status") { self.engine.status() }
    AsyncFunction("cancel") { self.engine.cancel() }
    AsyncFunction("logs") { self.engine.logs() }
    AsyncFunction("controlledError") { self.engine.controlledError() }
  }
}
