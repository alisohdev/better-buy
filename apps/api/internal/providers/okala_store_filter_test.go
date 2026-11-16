package providers

import "testing"

func TestOkalaSupermarketStore(t *testing.T) {
	for _, name := range []string{"نانوایی سنگک", "سوپرمیوه بهار", "سوپر میوه بهار", "میوه‌فروشی تازه", "میوه و تره بار"} {
		if okalaSupermarketStore(name) {
			t.Errorf("specialist accepted: %s", name)
		}
	}
	for _, name := range []string{"افق کوروش", "سوپرمارکت بهار", "هایپرمارکت میوه و مواد غذایی"} {
		if !okalaSupermarketStore(name) {
			t.Errorf("supermarket excluded: %s", name)
		}
	}
}
