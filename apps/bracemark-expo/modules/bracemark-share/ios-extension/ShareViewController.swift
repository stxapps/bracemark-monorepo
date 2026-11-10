import UIKit
import UniformTypeIdentifiers
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import BracemarkShare

// THE iOS SHARE EXTENSION'S VIEW CONTROLLER — the iOS twin of
// android/…/ShareActivity.kt (docs/share-sheet.md, _the shape_).
//
// It is the extension's NSExtensionPrincipalClass. It reads what the host
// shared, boots a React Native instance in the extension's own process, and
// mounts the root registered as `shareExtension` (index.share.js) with the
// share as its initial props.
//
// ⚠ THIS FILE IS COMPILED INTO THE EXTENSION TARGET ONLY. It sits outside the
// BracemarkShare pod's glob on purpose, and plugins/with-share-extension adds it
// to the target by reference — in place, not copied into `ios/`. So an edit made
// in Xcode lands HERE, in the tracked file, and survives `prebuild --clean`.
//
// Vendored from expo-share-extension 5.0.6 (MIT, © Max Ast; the licence is
// plugins/with-share-extension/LICENSE-expo-share-extension), whose controller
// this started as, and trimmed to what this app shares: one web URL (with
// Safari's preprocessing results) or text. Its image, video and file branches,
// Firebase, `openHostApp` and the Info.plist-driven height and background are
// gone. What it used to need four config plugins to patch is ordinary code here:
// the root view fills its superview (`configureRootView`), and the swipe hold
// and `close()` arrive through `ShareExtensionHost` (the BracemarkShare pod)
// rather than notifications.
//
// It still boots with React Native's own `RCTReactNativeFactory`, as upstream
// did, where the app's AppDelegate uses `ExpoReactNativeFactory`. That is
// deliberate for now — the vendoring's first phase changes no behaviour — and is
// the next thing to move (docs/dependency-upgrades.md, _the app-side blocker_).

class ShareReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    // Tagged `shareExtension=true` so metro.config.js can serve index.share.js
    // instead of the app's entry — as a production bundle, because the dev one
    // does not fit this process's memory (docs/share-sheet.md, _the share
    // extension has almost no memory to spare_, rule 2).
    let settings = RCTBundleURLProvider.sharedSettings()
    settings.enableDev = true
    settings.enableMinification = false
    if let bundleURL = settings.jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry") {
      if var components = URLComponents(url: bundleURL, resolvingAgainstBaseURL: false) {
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "shareExtension", value: "true")]
        return components.url ?? bundleURL
      }
      return bundleURL
    }
    fatalError("Could not create bundle URL")
#else
    // Embedded by the target's "Bundle React Native code and images" phase,
    // from index.share.js.
    guard let bundleURL = Bundle.main.url(forResource: "main", withExtension: "jsbundle") else {
      fatalError("Could not load bundle URL")
    }
    return bundleURL
#endif
  }
}

class ShareViewController: UIViewController, ShareExtensionHosting {
  private let loadingIndicator = UIActivityIndicatorView(style: .large)
  private var reactNativeFactory: RCTReactNativeFactory?
  private var reactNativeFactoryDelegate: RCTReactNativeFactoryDelegate?
  private var isCleanedUp = false

  deinit {
    cleanupAfterClose()
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    setupLoadingIndicator()
    isCleanedUp = false
    ShareExtensionHost.current = self

    self.view.contentScaleFactor = UIScreen.main.scale

    loadReactNativeContent()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    // Start cleanup early so the surface tears down before the sheet is gone.
    if isBeingDismissed {
      cleanupAfterClose()
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    // Closed by the system's swipe rather than by close().
    cleanupAfterClose()
  }

  // MARK: ShareExtensionHosting

  func close() {
    self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    cleanupAfterClose()
  }

  // The list and tag pickers hold the host sheet's swipe-to-dismiss off while
  // they are up (docs/share-sheet.md, _the pickers hold the system's swipe
  // off_), through BracemarkShareSwipeGuard.
  func setSwipeHeld(_ held: Bool) {
    isModalInPresentation = held
  }

  // MARK: React Native

  private func loadReactNativeContent() {
    getShareData { [weak self] sharedData in
      guard let self = self else { return }

      let delegate = ShareReactNativeDelegate()
      delegate.dependencyProvider = RCTAppDependencyProvider()
      let factory = RCTReactNativeFactory(delegate: delegate)
      reactNativeFactoryDelegate = delegate
      reactNativeFactory = factory

      var initialProps = sharedData ?? [:]
      // The container's size and scale, for JS that wants them
      // (features/share/share-url.ts reads only the share itself).
      initialProps["initialViewWidth"] = self.view.bounds.width
      initialProps["initialViewHeight"] = self.view.bounds.height
      initialProps["pixelRatio"] = UIScreen.main.scale
      initialProps["fontScale"] = UIFont.preferredFont(forTextStyle: .body).pointSize / 17.0

      let rootView = factory.rootViewFactory.view(
        withModuleName: "shareExtension",
        initialProperties: initialProps
      )
      configureRootView(rootView)
      view.addSubview(rootView)

      self.loadingIndicator.stopAnimating()
      self.loadingIndicator.removeFromSuperview()
    }
  }

  // ⚠ The root FILLS ITS SUPERVIEW — `view.bounds`, not `UIScreen.main.bounds`.
  // `frame` is in the superview's coordinates, and the share presentation puts
  // this controller's view 72pt down the screen on an iPhone (and floats it as a
  // form sheet on an iPad), so a screen-sized rect hung the sheet's bottom —
  // Save included — off the display. The autoresizing mask then keeps it
  // filling on rotation. (docs/share-sheet.md, _"Full-screen" is a SIZE_.)
  //
  // And it is CLEAR: the sheet's four screens are not one height, and
  // share-kit.tsx draws its own rounded panel inside this full-size root, over
  // the host app under the system's dimming. An opaque root showed as a slab of
  // dead white above the shorter screens.
  private func configureRootView(_ rootView: UIView) {
    rootView.backgroundColor = .clear
    rootView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    rootView.frame = view.bounds
  }

  private func setupLoadingIndicator() {
    view.addSubview(loadingIndicator)
    loadingIndicator.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      loadingIndicator.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      loadingIndicator.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
    loadingIndicator.startAnimating()
  }

  private func cleanupAfterClose() {
    if isCleanedUp { return }
    isCleanedUp = true

    if ShareExtensionHost.current === self {
      ShareExtensionHost.current = nil
    }

    view.subviews.forEach { subview in
      if subview is RCTRootView {
        subview.removeFromSuperview()
      }
    }

    reactNativeFactory = nil
    reactNativeFactoryDelegate = nil
  }

  // MARK: The share

  // What the host shared, as the initial props features/share/share-url.ts
  // reads: `url` for a web URL attachment, `preprocessingResults` for Safari's
  // run of share-extension/preprocessing.js, `text` for a text attachment that
  // carries no URL. The Info.plist's activation rule admits nothing else.
  //
  // A FILE url is skipped: the activation rule asks for web URLs, and the sheet
  // has nothing to do with a file. (Upstream copied such files into the App
  // Group container under `files`/`images`, which the sheet never read.)
  private func getShareData(completion: @escaping ([String: Any]?) -> Void) {
    guard let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] else {
      completion(nil)
      return
    }

    var sharedItems: [String: Any] = [:]
    let group = DispatchGroup()

    for item in extensionItems {
      for provider in item.attachments ?? [] {
        let hasURL = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)

        if hasURL {
          group.enter()
          provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { urlItem, _ in
            DispatchQueue.main.async {
              if let sharedURL = urlItem as? URL, !sharedURL.isFileURL {
                sharedItems["url"] = sharedURL.absoluteString
              }
              group.leave()
            }
          }
        }

        // Not else-if: Safari hands over the URL AND a property list carrying
        // the preprocessing results.
        if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
          group.enter()
          provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { item, _ in
            DispatchQueue.main.async {
              if let itemDict = item as? NSDictionary,
                 let results = itemDict[NSExtensionJavaScriptPreprocessingResultsKey] as? NSDictionary {
                sharedItems["preprocessingResults"] = results
              }
              group.leave()
            }
          }
        }

        if !hasURL && provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
          group.enter()
          provider.loadItem(forTypeIdentifier: UTType.text.identifier, options: nil) { textItem, _ in
            DispatchQueue.main.async {
              if let text = textItem as? String {
                sharedItems["text"] = text
              }
              group.leave()
            }
          }
        }
      }
    }

    group.notify(queue: .main) {
      completion(sharedItems.isEmpty ? nil : sharedItems)
    }
  }
}
