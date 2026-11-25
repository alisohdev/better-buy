Pod::Spec.new do |s|
  s.name = 'BetterBuyEngine'
  s.version = '0.1.0'
  s.summary = 'Fixture-only Go engine bridge'
  s.homepage = 'https://github.com/alisohdev/better-buy'
  s.author = 'Better Buy'
  s.source = { :git => 'https://github.com/alisohdev/better-buy.git' }
  s.platform = :ios, '16.4'
  s.source_files = '*.swift'
  s.vendored_frameworks = 'BetterBuyEngineKit.xcframework'
  s.dependency 'ExpoModulesCore'
end
