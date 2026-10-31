package com.phonepilot.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureBackendConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences("phonepilot_backend", Context.MODE_PRIVATE)

    fun save(config: BackendConfig) {
        require(config.isValid) { "Worker configuration must use HTTPS and a token" }
        prefs.edit().putString(URL, config.workerUrl.trimEnd('/')).putString(TOKEN, encrypt(config.deviceToken)).apply()
    }

    fun load(): BackendConfig? {
        val url = prefs.getString(URL, null) ?: return null
        val token = prefs.getString(TOKEN, null)?.let(::decrypt) ?: return null
        return BackendConfig(url, token).takeIf { it.isValid }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String? = runCatching {
        val parts = value.split(':'); require(parts.size == 2)
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))) }
            .doFinal(Base64.decode(parts[1], Base64.NO_WRAP)).decodeToString()
    }.getOrNull()

    private companion object { const val KEY_ALIAS = "phonepilot_device_token"; const val URL = "worker_url"; const val TOKEN = "device_token" }
}
