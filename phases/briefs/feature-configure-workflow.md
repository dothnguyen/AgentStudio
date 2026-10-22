I want to be able to configure a dynamic workflow in JSON or YAML format.
The workflow should list stages in order. Each stage has the role that does it (TeamLead / Developer / QA), its permission level, the prompt template, and where each verdict goes next. For example: QA fail → back to Developer; pass → TeamLead; TeamLead fail → Developer.

I want to be able to tell the team to run the workflow with a prompt.

Make this one phase-01, remove the current phase-01 story; update the roadmap and prd as well.