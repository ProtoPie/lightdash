resource "aws_lb" "lightdash" {

  name               = "lightdash-dev"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.lightdash-sg.id]
  subnets            = data.aws_subnets.public.ids
  idle_timeout       = 300

}

resource "aws_security_group" "lightdash-sg" {
  tags = merge(
    local.common_tags,
    {
      Product = "lightdash"
    }
  )
  name        = "lightdash-sg-dev"
  description = "controls access to the LB"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP from VPC"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]

  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb_listener" "lightdash-https-listener" {
  load_balancer_arn = aws_lb.lightdash.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-2016-08"
  certificate_arn   = "arn:aws:acm:us-west-2:750128304405:certificate/c82bd355-6d67-4083-a2d5-76eb1ec061ff"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.lightdash_target_group.arn
  }
}

resource "aws_lb_listener" "lightdash-http-listener" {
  load_balancer_arn = aws_lb.lightdash.arn
  port              = "80"
  protocol          = "HTTP"


  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
