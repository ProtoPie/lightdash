resource "aws_lb_target_group" "lightdash_target_group" {
  tags = merge(
    local.common_tags,
    {
      Product = "webx"
    }
  )
  name        = "lightdash-target-group"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    interval            = 60
    path                = "/api/v1/health"
    healthy_threshold   = 5
    unhealthy_threshold = 3
  }

  load_balancing_algorithm_type = "least_outstanding_requests"
}