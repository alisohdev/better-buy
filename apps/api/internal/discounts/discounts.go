package discounts

const (
	Minimum = 15
	Maximum = 80
)

func Valid(percent int) bool { return percent >= Minimum && percent <= Maximum }
