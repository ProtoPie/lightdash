resource "aws_route53_record" "lightdash" {
  zone_id         = "Z2VMU0LK8P5XH0"
  name            = "lightdash.protopie.io"
  type            = "A"
  allow_overwrite = true

  alias {
    name                   = aws_lb.lightdash.dns_name
    zone_id                = aws_lb.lightdash.zone_id
    evaluate_target_health = true
  }
}

