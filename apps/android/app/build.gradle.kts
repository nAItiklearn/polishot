import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

// :app is the Compose application. Kotlin comes from AGP 9's built-in Kotlin support, so there is no
// `org.jetbrains.kotlin.android` plugin here. The Compose compiler plugin and KSP (Room) are the only
// Kotlin-side plugins.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

/* ------------------------------------------------------------------------------------------------ */
/* Paths                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

// apps/android -> repository root (two levels up).
val repoRoot: File = rootProject.projectDir.resolve("../..").canonicalFile
val editorHostDir: File = rootProject.projectDir.resolve("editor-host")
val editorAssetsDir: File = projectDir.resolve("src/main/assets/editor")
val licensePublicKeyFile: File = repoRoot.resolve("packages/license/public-key.hex")
val licenseVectorsFile: File = repoRoot.resolve("packages/license/test-vectors.json")

/* ------------------------------------------------------------------------------------------------ */
/* Release signing: env vars when present, debug signing otherwise                                    */
/* ------------------------------------------------------------------------------------------------ */

val releaseKeystorePath: String? = providers.environmentVariable("POLISHOT_KEYSTORE").orNull
val hasReleaseSigning: Boolean = !releaseKeystorePath.isNullOrBlank()

/* ------------------------------------------------------------------------------------------------ */
/* Build date, for the licence update window (docs/CONTRACTS.md section 5b)                           */
/* ------------------------------------------------------------------------------------------------ */

// Days since the Unix epoch at build time; a key covers every build dated up to issuedDays + 365.
// `-PbuildDays=<n>` pins the value (reproducible builds, tests).
val buildDays: Long = providers.gradleProperty("buildDays")
    .map { it.trim().toLong() }
    .orElse(System.currentTimeMillis() / 86_400_000L)
    .get()

android {
    namespace = "app.polishot"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.polishot"
        minSdk = 29
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("long", "BUILD_DAYS", "${buildDays}L")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(requireNotNull(releaseKeystorePath))
                storePassword = providers.environmentVariable("POLISHOT_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("POLISHOT_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("POLISHOT_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/versions/**",
                "/META-INF/DEPENDENCIES",
                "/META-INF/LICENSE*",
                "/META-INF/NOTICE*",
            )
        }
    }

    testOptions {
        unitTests {
            // Robolectric needs merged resources and the manifest.
            isIncludeAndroidResources = true
            // Pure-JVM tests may touch trivial android.* calls (Log, Uri parsing helpers).
            isReturnDefaultValues = true
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        // Fatal-only lint on every release build is redundant with the explicit `lint` task in CI.
        checkReleaseBuilds = false
    }
}

kotlin {
    jvmToolchain(17)
}

ksp {
    // Room exports its schema JSON here; commit the files so migrations can be reviewed.
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    // Encrypted LAN transfer (pure Kotlin/JVM, developed in apps/android/quicksend).
    implementation(project(":quicksend"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.webkit)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.mlkit.text.recognition)
    implementation(libs.bouncycastle.bcprov)
    implementation(libs.kotlinx.coroutines.android)

    // Compose UI tooling for the debug variant: the empty host activity that createComposeRule() launches.
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.junit)
    testImplementation(libs.org.json)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.androidx.compose.ui.test.junit4)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}

/* ------------------------------------------------------------------------------------------------ */
/* Single source of truth for the production licence public key                                       */
/* ------------------------------------------------------------------------------------------------ */

// Reads packages/license/public-key.hex and writes a Kotlin constant, so the Android app can never
// drift from the TypeScript and Rust verifiers. The shared test vectors (packages/license/test-vectors.json)
// use a separate test-only key and are passed to the verifier explicitly by the tests.
abstract class GenerateLicensePublicKey : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val publicKeyFile: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val hex = publicKeyFile.get().asFile.readText().trim().lowercase()
        require(Regex("[0-9a-f]{64}").matches(hex)) {
            "packages/license/public-key.hex must contain exactly 64 hex characters"
        }
        val dir = outputDir.get().asFile.resolve("app/polishot/license")
        dir.mkdirs()
        dir.resolve("LicensePublicKey.kt").writeText(
            """
            // Generated by :app:generateLicensePublicKey from packages/license/public-key.hex. Do not edit.
            package app.polishot.license

            internal const val PROD_PUBLIC_KEY_HEX: String = "$hex"
            """.trimIndent() + "\n",
        )
    }
}

val generateLicensePublicKey = tasks.register<GenerateLicensePublicKey>("generateLicensePublicKey") {
    group = "polishot"
    description = "Generates LicensePublicKey.kt from packages/license/public-key.hex."
    publicKeyFile.set(licensePublicKeyFile)
    outputDir.set(layout.buildDirectory.dir("generated/polishot/license"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.kotlin?.addGeneratedSourceDirectory(
            generateLicensePublicKey,
            GenerateLicensePublicKey::outputDir,
        )
    }
}

/* ------------------------------------------------------------------------------------------------ */
/* WebView editor: Vite build of apps/android/editor-host into src/main/assets/editor                  */
/* ------------------------------------------------------------------------------------------------ */

// Skip with `-PskipEditorBuild` (for example when assets/editor was already built by a previous run).
val skipEditorBuild: Boolean = providers.gradleProperty("skipEditorBuild").isPresent

val buildEditorHost = tasks.register<Exec>("buildEditorHost") {
    group = "polishot"
    description = "Builds apps/android/editor-host (Vite) into app/src/main/assets/editor."
    workingDir = repoRoot

    val pnpm = listOf("pnpm", "--filter", "@polishot/android-editor-host", "build")
    val isWindows = System.getProperty("os.name").lowercase().contains("windows")
    commandLine(if (isWindows) listOf("cmd", "/c") + pnpm else pnpm)

    inputs.files(
        fileTree(editorHostDir) {
            include("src/**", "public/**", "index.html", "vite.config.ts", "tsconfig.json", "package.json")
        },
    )
    inputs.files(
        fileTree(repoRoot.resolve("packages")) {
            include("brand/src/**", "editor/src/**", "redact/src/**")
        },
    )
    inputs.file(repoRoot.resolve("pnpm-lock.yaml"))
    outputs.dir(editorAssetsDir)

    onlyIf { !skipEditorBuild }
}

// Everything that reads src/main/assets (asset merging, lint) must run after the editor build, otherwise
// Gradle reports an undeclared dependency on the task's output directory.
tasks.configureEach {
    val consumesAssets = name != "buildEditorHost" &&
        (name.startsWith("lint") || (name.startsWith("merge") && name.endsWith("Assets")))
    if (consumesAssets) {
        dependsOn(buildEditorHost)
    }
}

/* ------------------------------------------------------------------------------------------------ */
/* Tests                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

tasks.withType<Test>().configureEach {
    // The licence verifier is tested against the vectors shared with the TypeScript and Rust implementations.
    inputs.file(licenseVectorsFile)
    systemProperty("polishot.licenseVectors", licenseVectorsFile.absolutePath)
    maxHeapSize = "1g"
}

// Compose UI tests need the debug-only ui-test-manifest, so the release unit-test task would fail; the debug
// unit tests exercise the same code.
tasks.matching { it.name == "testReleaseUnitTest" }.configureEach {
    enabled = false
}
