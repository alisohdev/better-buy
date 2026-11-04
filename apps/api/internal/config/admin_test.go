package config

import (
	"reflect"
	"testing"
)

func TestAdminEmailsAreExplicitAddresses(t *testing.T) {
	got, err := adminEmails(" ADMIN@example.com, admin@example.com, second@example.com ")
	if err != nil || !reflect.DeepEqual(got, []string{"admin@example.com", "second@example.com"}) {
		t.Fatalf("allowlist: %v %v", got, err)
	}
	got, err = adminEmails("")
	if err != nil || len(got) != 0 {
		t.Fatalf("empty allowlist: %v %v", got, err)
	}
	for _, invalid := range []string{"*", "@example.com", "Admin <admin@example.com>", "admin@example.com;second@example.com"} {
		if _, err := adminEmails(invalid); err == nil {
			t.Fatalf("accepted invalid allowlist %q", invalid)
		}
	}
}
