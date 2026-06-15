resource "aws_security_group" "ecs_sg" {
  tags = merge(
    local.common_tags,
    {
      Product = "lightdash-ecs-sg"
    }
  )

  name        = "lightdash-ecs-sg-dev"
  description = "allow inbound access from anyone"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    protocol        = "tcp"
    from_port       = 8080
    to_port         = 8080
    security_groups = [aws_security_group.lightdash-sg.id]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = values(data.aws_subnet.public_subnets)[*].cidr_block
  }

  # smtp outbound ingress
  egress {
    from_port   = 587
    to_port     = 587
    protocol    = "tcp"
    cidr_blocks = values(data.aws_subnet.public_subnets)[*].cidr_block
  }

}

resource "aws_security_group" "database_sg" {

  name        = "lightdash-db-sg-dev"
  description = "allow inbound access from anyone"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    protocol    = "tcp"
    from_port   = local.envs["PGPORT"]
    to_port     = local.envs["PGPORT"]
    cidr_blocks = values(data.aws_subnet.private_subnets)[*].cidr_block
  }


  ingress {
    protocol    = "tcp"
    from_port   = local.envs["PGPORT"]
    to_port     = local.envs["PGPORT"]
    cidr_blocks = values(data.aws_subnet.public_subnets)[*].cidr_block
  }

  ingress {
    description = "Seoul HQ"
    protocol    = "tcp"
    from_port   = local.envs["PGPORT"]
    to_port     = local.envs["PGPORT"]
    cidr_blocks = ["218.48.79.82/32"]
  }

  ingress {
    description = "sol local"
    protocol    = "tcp"
    from_port   = local.envs["PGPORT"]
    to_port     = local.envs["PGPORT"]
    cidr_blocks = ["58.230.166.64/32"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}