// Gradle project root for the Polishot Android app (apps/android).
//
// Modules:
//   :app        the Compose app (capture service, editor host WebView, history, license).
//   :quicksend  pure Kotlin/JVM module with the encrypted LAN transfer protocol (owned by another workstream).
//
// The WebView editor (apps/android/editor-host) is a pnpm package, not a Gradle module; the :app task
// `buildEditorHost` runs its Vite build into app/src/main/assets/editor before assets are merged.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Polishot"

include(":app")
include(":quicksend")
