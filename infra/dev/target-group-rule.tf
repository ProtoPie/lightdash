resource "aws_lb_listener_rule" "lightdash_tg_rule_1" {
  tags = merge(
    local.common_tags,
    {
      Product = "lightdash"
    }
  )
  listener_arn = aws_lb_listener.lightdash-https-listener.id
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.lightdash_target_group.arn
  }
  condition {
    host_header {
      values = ["lightdash.protopie.*"]
    }
  }
}
