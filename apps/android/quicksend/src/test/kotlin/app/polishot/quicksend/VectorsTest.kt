package app.polishot.quicksend

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/** Asserts every derived value in packages/quicksend-vectors/vectors.json, which the Rust crate generated. */
class VectorsTest {

    @Test
    fun identitiesAreReproducedByTheJcaImplementation() {
        for (name in listOf("a", "b")) {
            val o = Vectors.root.getJSONObject("identities").getJSONObject(name)
            // fromBytes checks d*G against the stated public key, so this also proves the JCA agrees with Rust
            val id = Vectors.identity(name)
            assertEquals(o.getString("public"), hex(id.publicKey))
            assertEquals(o.getString("id"), id.id.toString())
            assertEquals(o.getString("private") + o.getString("public"), hex(id.toBytes()))
            assertEquals(id.id, DeviceId.parse(o.getString("id").lowercase()))
        }
    }

    @Test
    fun aPublicKeyThatDoesNotMatchThePrivateKeyIsRejected() {
        val a = Vectors.root.getJSONObject("identities").getJSONObject("a")
        val b = Vectors.root.getJSONObject("identities").getJSONObject("b")
        val e = assertThrows<QuickSendException> {
            Identity.fromBytes(unhex(a.getString("private")) + unhex(b.getString("public")))
        }
        assertEquals(Failure.INVALID_INPUT, e.failure)
    }

    @Test
    fun deviceIdBase32() {
        val cases = Vectors.root.getJSONArray("device_id_cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val id = DeviceId.fromBytes(unhex(c.getString("bytes")))
            assertEquals(c.getString("id"), id.toString())
            assertArrayEquals(unhex(c.getString("bytes")), DeviceId.parse(c.getString("id")).toBytes())
        }
    }

    @Test
    fun sasMatchesIncludingValuesWithTheTopBitSet() {
        val cases = Vectors.root.getJSONArray("sas_cases")
        var sawTopBit = false
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val transcript = unhex(c.getString("transcript"))
            val okm = Crypto.hkdf(ByteArray(0), transcript, Protocol.I_SAS, 8)
            assertEquals(c.getString("okm"), hex(okm))
            assertEquals(c.getString("sas"), sasFromTranscript(transcript))
            if ((okm[0].toInt() and 0x80) != 0) sawTopBit = true
        }
        assertTrue(sawTopBit, "the corpus must exercise unsigned 64-bit arithmetic")
    }

    @Test
    fun stringSanitizers() {
        val cases = Vectors.root.getJSONObject("string_cases")
        val sanitize = cases.getJSONArray("sanitize_file_name")
        for (i in 0 until sanitize.length()) {
            val c = sanitize.getJSONObject(i)
            val out = Content.sanitizeFileName(c.getString("in"))
            assertEquals(c.getString("out"), out, "sanitize ${c.getString("in")}")
            assertEquals(out, Content.sanitizeFileName(out), "idempotent")
        }
        val clean = cases.getJSONArray("clean_device_name")
        for (i in 0 until clean.length()) {
            val c = clean.getJSONObject(i)
            assertEquals(c.getString("out"), Content.cleanDeviceName(c.getString("in")), "clean ${c.getString("in")}")
        }
    }

    @Test
    fun pairingDerivationMatchesFromBothSides() {
        val v = Vectors.pairing
        val a = Vectors.identity("a")
        val b = Vectors.identity("b")
        val ephI = Vectors.key(v.getJSONObject("ephemeral_initiator"))
        val ephR = Vectors.key(v.getJSONObject("ephemeral_responder"))
        val nameI = v.getString("initiator_name")
        val nameR = v.getString("responder_name")
        val ver = v.getInt("version")

        assertEquals(v.getString("commit"), hex(commitment(ver, a.key.publicBytes, ephI.publicBytes)))
        assertEquals(v.getString("z_ee"), hex(ephI.ecdh(ephR.publicBytes)))
        assertEquals(v.getString("z_ee"), hex(ephR.ecdh(ephI.publicBytes)))
        assertEquals(v.getString("z_ss"), hex(a.key.ecdh(b.key.publicBytes)))
        assertEquals(v.getString("z_ss"), hex(b.key.ecdh(a.key.publicBytes)))

        val fromI = derivePairing(ver, a.key, ephI, nameI, b.key.publicBytes, ephR.publicBytes, nameR)
        val fromR = derivePairing(ver, b.key, ephR, nameR, a.key.publicBytes, ephI.publicBytes, nameI)
        for (d in listOf(fromI, fromR)) {
            assertEquals(v.getString("transcript"), hex(d.transcript))
            assertEquals(v.getString("sas"), d.sas)
            assertEquals(v.getString("pair_key"), hex(d.pairKey))
        }
        val key = unhex(v.getString("pair_key"))
        val t = unhex(v.getString("transcript"))
        assertEquals(v.getString("confirm_mac_initiator"), hex(Crypto.hmacSha256(key, Protocol.L_CONFIRM_I, t)))
        assertEquals(v.getString("confirm_mac_responder"), hex(Crypto.hmacSha256(key, Protocol.L_CONFIRM_R, t)))
    }

    @Test
    fun pairRecordEncodingMatches() {
        val v = Vectors.pairing
        val b = Vectors.identity("b")
        val rec = PairRecord(b.publicKey, unhex(v.getString("pair_key")), v.getString("responder_name"))
        assertEquals(v.getString("record_initiator_has_responder"), hex(rec.toBytes()))
        val back = PairRecord.fromBytes(unhex(v.getString("record_initiator_has_responder")))
        assertEquals(b.id, back.peerId)
        assertEquals(v.getString("responder_name"), back.peerName)
    }

    @Test
    fun transferKeyScheduleMatches() {
        val t = Vectors.transfer
        val a = Vectors.identity("a")
        val b = Vectors.identity("b")
        val ephS = Vectors.key(t.getJSONObject("ephemeral_sender"))
        val ephR = Vectors.key(t.getJSONObject("ephemeral_receiver"))
        val pairKey = unhex(t.getString("pair_key"))
        assertEquals(t.getString("z"), hex(ephS.ecdh(ephR.publicBytes)))

        val fromSender = deriveSession(1, a.id, b.id, ephS.publicBytes, ephR.publicBytes, ephS, ephR.publicBytes, pairKey)
        val fromReceiver = deriveSession(1, a.id, b.id, ephS.publicBytes, ephR.publicBytes, ephR, ephS.publicBytes, pairKey)
        for (k in listOf(fromSender, fromReceiver)) {
            assertEquals(t.getString("transcript"), hex(k.transcript))
            assertEquals(t.getString("k_s2r"), hex(k.kS2r))
            assertEquals(t.getString("k_r2s"), hex(k.kR2s))
            assertEquals(t.getString("auth_s"), hex(k.authS))
            assertEquals(t.getString("auth_r"), hex(k.authR))
        }
    }

    @Test
    fun sealedFramesMatchByteForByte() {
        val t = Vectors.transfer
        val key = unhex(t.getString("k_s2r"))
        val frames = t.getJSONArray("aead_sender_to_receiver")
        val sealer = Sealer(key, Protocol.DIR_S2R, 1)
        val opener = Sealer(key, Protocol.DIR_S2R, 1)
        for (i in 0 until frames.length()) {
            val f = frames.getJSONObject(i)
            val type = f.getInt("type")
            val plaintext = unhex(f.getString("plaintext"))
            val ct = sealer.seal(type, plaintext)
            assertEquals(f.getString("ciphertext"), hex(ct), "ciphertext $i")
            assertEquals(f.getString("frame"), hex(frameBytes(type, ct)), "frame $i")
            assertEquals(f.getString("nonce"), hex(Protocol.DIR_S2R + u64Bytes(f.getLong("counter"))), "nonce $i")
            assertEquals(f.getString("aad"), hex(byteArrayOf(1, type.toByte())), "aad $i")
            assertArrayEquals(plaintext, opener.open(type, unhex(f.getString("ciphertext"))), "open $i")
        }
        val back = t.getJSONObject("aead_receiver_to_sender_first")
        val reverse = Sealer(unhex(t.getString("k_r2s")), Protocol.DIR_R2S, 1)
        assertEquals(back.getString("ciphertext"), hex(reverse.seal(back.getInt("type"), ByteArray(0))))
    }

    @Test
    fun aFrameOpenedWithTheWrongDirectionOrKeyFails() {
        val t = Vectors.transfer
        val first = t.getJSONArray("aead_sender_to_receiver").getJSONObject(0)
        val ct = unhex(first.getString("ciphertext"))
        val type = first.getInt("type")
        val wrongDirection = Sealer(unhex(t.getString("k_s2r")), Protocol.DIR_R2S, 1)
        assertEquals(Failure.CRYPTO, assertThrows<QuickSendException> { wrongDirection.open(type, ct) }.failure)
        val wrongKey = Sealer(unhex(t.getString("k_r2s")), Protocol.DIR_S2R, 1)
        assertEquals(Failure.CRYPTO, assertThrows<QuickSendException> { wrongKey.open(type, ct) }.failure)
        val wrongType = Sealer(unhex(t.getString("k_s2r")), Protocol.DIR_S2R, 1)
        assertEquals(Failure.CRYPTO, assertThrows<QuickSendException> { wrongType.open(FrameType.DONE, ct) }.failure)
    }

    @Test
    fun hkdfAndHmacKnownAnswers() {
        // RFC 5869 appendix A.1
        val okm = Crypto.hkdf(
            unhex("000102030405060708090a0b0c"),
            unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
            unhex("f0f1f2f3f4f5f6f7f8f9"),
            42,
        )
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            hex(okm),
        )
        // RFC 4231 test case 2
        val mac = Crypto.hmacSha256("Jefe".toByteArray(), "what do ya want ".toByteArray(), "for nothing?".toByteArray())
        assertEquals("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", hex(mac))
    }

    @Test
    fun publicKeyValidation() {
        val a = Vectors.identity("a")
        val good = a.publicKey
        Crypto.decodePublic(good)
        val offCurve = good.copyOf()
        offCurve[64] = (offCurve[64].toInt() xor 1).toByte()
        assertEquals(Failure.PROTOCOL, assertThrows<QuickSendException> { Crypto.decodePublic(offCurve) }.failure)
        assertEquals(Failure.PROTOCOL, assertThrows<QuickSendException> { Crypto.decodePublic(ByteArray(65)) }.failure)
        assertEquals(Failure.PROTOCOL, assertThrows<QuickSendException> { Crypto.decodePublic(good.copyOf(64)) }.failure)
        val compressed = ByteArray(33)
        compressed[0] = 2
        assertEquals(Failure.PROTOCOL, assertThrows<QuickSendException> { Crypto.decodePublic(compressed) }.failure)
    }

    private fun frameBytes(type: Int, body: ByteArray): ByteArray {
        val len = 1 + body.size
        val out = ByteArray(5 + body.size)
        out[0] = (len ushr 24).toByte()
        out[1] = (len ushr 16).toByte()
        out[2] = (len ushr 8).toByte()
        out[3] = len.toByte()
        out[4] = type.toByte()
        System.arraycopy(body, 0, out, 5, body.size)
        return out
    }
}
