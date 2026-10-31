plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "com.phonepilot.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.phonepilot.app"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation(project(":core"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation(kotlin("test"))
}
