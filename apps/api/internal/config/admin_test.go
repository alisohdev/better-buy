package config

import (
	"reflect"
	"testing"
)

func TestAdminPhonesAreNormalized(t *testing.T) {
	got, err := adminPhones(" 09123456789, +989123456789, 09351234567 ")
	if err != nil || !reflect.DeepEqual(got, []string{"+989123456789", "+989351234567"}) {
		t.Fatalf("allowlist: %v %v", got, err)
	}
	got, err = adminPhones("")
	if err != nil || len(got) != 0 {
		t.Fatalf("empty allowlist: %v %v", got, err)
	}
	for _, invalid := range []string{"*", "@example.com", "Admin <admin@example.com>", "admin@example.com;second@example.com"} {
		if _, err := adminPhones(invalid); err == nil {
			t.Fatalf("accepted invalid allowlist %q", invalid)
		}
	}
}
