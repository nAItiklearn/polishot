// Top-level build file. Plugins are declared here (without applying them) so every module resolves one
// version of each, taken from gradle/libs.versions.toml.
//
// AGP 9 ships built-in Kotlin support, so there is deliberately no `org.jetbrains.kotlin.android` plugin.
// `kotlin-jvm` is only for the pure-JVM :quicksend module.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.ksp) apply false
}
