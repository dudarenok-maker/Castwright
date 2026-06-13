import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// app-11: release signing. `android/key.properties` (git-ignored) supplies the
// real upload keystore for distribution; absent (CI / fresh clone) we fall back
// to debug signing so `flutter build apk --release` still produces an
// installable sideload APK for alpha.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) load(FileInputStream(keystorePropertiesFile))
}
val hasReleaseKeystore = keystorePropertiesFile.exists()

android {
    namespace = "ai.castwright"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "ai.castwright"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = (keystoreProperties["storeFile"] as String?)?.let { file(it) }
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }

    buildTypes {
        release {
            // app-2: disable R8 minification/shrinking. ML Kit barcode scanning
            // (google_mlkit_barcode_scanning) loads classes via reflection and
            // ships NO consumer ProGuard rules, so R8 strips them and the scanner
            // NPEs at runtime ("getClass() on a null object reference"). The prior
            // flutter_zxing build was fine under R8 (C++/FFI, no reflection). For
            // an alpha sideload, turning shrinking off is the certain fix; a later
            // pass could re-enable it with tuned ML Kit keep rules to reclaim size.
            isMinifyEnabled = false
            isShrinkResources = false
            // Real upload key when key.properties is present; debug fallback
            // otherwise so the release APK still builds + sideloads for alpha.
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
