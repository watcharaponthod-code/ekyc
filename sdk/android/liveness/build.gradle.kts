plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("maven-publish")
}

group = "com.ekyc"
version = "1.0.0"

android {
    namespace = "com.ekyc.liveness"
    compileSdk = 35
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    publishing { singleVariant("release") { withSourcesJar() } }
}

dependencies {
    // On-device face detection (bundled model: works offline, ~6 MB).
    implementation("com.google.mlkit:face-detection:16.1.7")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    testImplementation("junit:junit:4.13.2")
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = "com.ekyc"
                artifactId = "liveness-android"
                version = project.version.toString()
                pom {
                    name.set("eKYC Liveness (Android)")
                    description.set("On-device liveness: ML Kit challenges + screen flash, no server.")
                }
            }
        }
        repositories {
            // `./gradlew :liveness:publishReleasePublicationToLocalRepoRepository` → build/repo
            // (a plain Maven layout with the POM, so hosts resolve ML Kit/CameraX transitively).
            maven {
                name = "localRepo"
                url = uri(layout.buildDirectory.dir("repo"))
            }
        }
    }
}
