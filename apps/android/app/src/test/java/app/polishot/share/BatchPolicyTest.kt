package app.polishot.share

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BatchPolicyTest {
    @Test
    fun `free runs process at most five images`() {
        assertEquals(5, BatchPolicy.FREE_BATCH_LIMIT)
        val plan = BatchPolicy.plan(requested = 8, pro = false)
        assertEquals(5, plan.accepted)
        assertEquals(3, plan.dropped)
        assertTrue(plan.limited)
    }

    @Test
    fun `free runs at or under the limit are not limited`() {
        for (n in 0..5) {
            val plan = BatchPolicy.plan(requested = n, pro = false)
            assertEquals(n, plan.accepted)
            assertEquals(0, plan.dropped)
            assertFalse("n=$n", plan.limited)
        }
    }

    @Test
    fun `pro is not held to the free limit`() {
        val plan = BatchPolicy.plan(requested = 40, pro = true)
        assertEquals(40, plan.accepted)
        assertFalse(plan.limited)
    }

    @Test
    fun `pro keeps only a technical ceiling`() {
        val plan = BatchPolicy.plan(requested = 250, pro = true)
        assertEquals(BatchPolicy.PRO_CEILING, plan.accepted)
        assertEquals(150, plan.dropped)
    }

    @Test
    fun `a negative request never produces negative counts`() {
        val plan = BatchPolicy.plan(requested = -3, pro = false)
        assertEquals(0, plan.accepted)
        assertEquals(0, plan.dropped)
    }
}
